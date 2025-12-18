import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

// --- SUPABASE AYARLARI ---
const SUPABASE_URL = 'https://pnnaugidvrsawepdhpdp.supabase.co'; // Burayı değiştir!
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBubmF1Z2lkdnJzYXdlcGRocGRwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQzNDc0MTMsImV4cCI6MjA2OTkyMzQxM30.4C2MgOC4yKP8_3aTXoJHB1Ugvv-u7NDOhrFR1R32W-0'; // Burayı değiştir!
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface Question {
  id: number;
  text: string;
  options: string[];
  answer: number;
}

interface Room {
  id: string;
  name: string;
  players: string[];
  questions: Question[];
  currentQuestionIndex: number;
  answeredPlayers: string[];
  timer: NodeJS.Timeout | null;
}

const QUESTION_DURATION = 10;
const rooms: Record<string, Room> = {};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const broadcastRooms = () => {
  const availableRooms = Object.values(rooms)
    .filter(r => r.players.length < 2)
    .map(r => ({ id: r.id, name: r.name, playerCount: r.players.length }));
  io.emit('update_rooms', availableRooms);
};

const startTimer = (roomID: string) => {
  const room = rooms[roomID];
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);

  room.timer = setTimeout(() => {
    const winners = room.players.filter(p => room.answeredPlayers.includes(p));
    winners.forEach(id => io.to(id).emit('game_over', { result: 'win_enemy_timeout' }));
    
    const losers = room.players.filter(p => !room.answeredPlayers.includes(p));
    losers.forEach(id => io.to(id).emit('game_over', { result: 'time_out' }));

    delete rooms[roomID];
    broadcastRooms();
  }, QUESTION_DURATION * 1000);
};

io.on('connection', (socket: Socket) => {
  broadcastRooms();

  // CHALLENGE OLUŞTURMA: Deste seçilince tetiklenir
  socket.on('create_room', async ({ deck_id, deck_name }) => {
    try {
      // 1. Destedeki kartları çek
      const { data: cards, error } = await supabase
        .from('flashcards')
        .select('front_word, back_word')
        .eq('deck_id', deck_id);

      if (error || !cards || cards.length < 4) {
        socket.emit('error', 'Bu destede yeterli kart yok (En az 4 kart lazım).');
        return;
      }

      // 2. Rastgele 10 kart seç ve test sorusuna dönüştür
      const shuffledCards = cards.sort(() => 0.5 - Math.random()).slice(0, 10);
      const dynamicQuestions: Question[] = shuffledCards.map((card, idx) => {
        const correct = card.back_word;
        // Yanlış şıklar için tüm desteden rastgele kelimeler al
        const distractors = cards
          .filter(c => c.back_word !== correct)
          .map(c => c.back_word)
          .sort(() => 0.5 - Math.random())
          .slice(0, 3);

        const options = [...distractors, correct].sort(() => 0.5 - Math.random());
        return {
          id: idx,
          text: card.front_word,
          options,
          answer: options.indexOf(correct)
        };
      });

      // 3. Odayı kur
      const roomID = Math.random().toString(36).substring(7);
      rooms[roomID] = {
        id: roomID,
        name: `${deck_name} Challenge`,
        players: [socket.id],
        questions: dynamicQuestions,
        currentQuestionIndex: 0,
        answeredPlayers: [],
        timer: null
      };

      socket.join(roomID);
      socket.emit('room_created', roomID);
      broadcastRooms();
    } catch (err) {
      console.error("Oda oluşturma hatası:", err);
    }
  });

  socket.on('join_room', (roomID) => {
    const room = rooms[roomID];
    if (room && room.players.length < 2) {
      room.players.push(socket.id);
      socket.join(roomID);
      io.to(roomID).emit('game_start', { 
        question: room.questions[0], 
        duration: QUESTION_DURATION 
      });
      startTimer(roomID);
      broadcastRooms();
    }
  });

  socket.on('submit_answer_simple', ({ answerIndex }) => {
    const roomID = Array.from(socket.rooms).find(r => rooms[r]);
    if (!roomID) return;
    const room = rooms[roomID];

    if (room.answeredPlayers.includes(socket.id)) return;
    room.answeredPlayers.push(socket.id);

    const isCorrect = answerIndex === room.questions[room.currentQuestionIndex].answer;

    if (!isCorrect) {
      if (room.timer) clearTimeout(room.timer);
      socket.emit('game_over', { result: 'lose' });
      room.players.find(id => id !== socket.id) && io.to(room.players.find(id => id !== socket.id)!).emit('game_over', { result: 'win' });
      delete rooms[roomID];
      broadcastRooms();
    } else {
      if (room.answeredPlayers.length === 1) {
        socket.emit('waiting_opponent');
      } else {
        if (room.timer) clearTimeout(room.timer);
        room.answeredPlayers = [];
        room.currentQuestionIndex++;

        if (room.currentQuestionIndex >= room.questions.length) {
          io.to(roomID).emit('game_over', { result: 'draw' });
          delete rooms[roomID];
          broadcastRooms();
        } else {
          io.to(roomID).emit('next_question', { 
            question: room.questions[room.currentQuestionIndex], 
            duration: QUESTION_DURATION 
          });
          startTimer(roomID);
        }
      }
    }
  });

  socket.on('disconnecting', () => {
    const roomID = Array.from(socket.rooms).find(r => rooms[r]);
    if (roomID) {
      io.to(roomID).emit('game_over', { result: 'opponent_left' });
      delete rooms[roomID];
      broadcastRooms();
    }
  });
});

httpServer.listen(3000, '0.0.0.0', () => console.log('🚀 Challenge Sunucusu Yayında: 3000'));