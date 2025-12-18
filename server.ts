import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

// --- SUPABASE BAĞLANTISI ---
const supabase = createClient(
  'YOUR_SUPABASE_URL', 
  'YOUR_SUPABASE_ANON_KEY'
);

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
  if (!room || room.timer) return;
  
  room.timer = setTimeout(() => {
    const winners = room.players.filter(p => room.answeredPlayers.includes(p));
    const losers = room.players.filter(p => !room.answeredPlayers.includes(p));

    losers.forEach(id => io.to(id).emit('game_over', { result: 'time_out' }));
    winners.forEach(id => io.to(id).emit('game_over', { result: 'win_enemy_timeout' }));

    delete rooms[roomID];
    broadcastRooms();
  }, QUESTION_DURATION * 1000);
};

io.on('connection', (socket: Socket) => {
  broadcastRooms();

  // Deste seçerek oda oluşturma
  socket.on('create_room', async ({ deck_id, deck_name }) => {
    const { data: cards, error } = await supabase
      .from('flashcards')
      .select('front_word, back_word')
      .eq('deck_id', deck_id)
      .limit(10);

    if (error || !cards || cards.length === 0) return;

    // Kartları 4 şıklı soru formatına dönüştür
    const dynamicQuestions: Question[] = cards.map((card, idx) => {
      const correct = card.back_word;
      const distractors = cards
        .filter(c => c.back_word !== correct)
        .map(c => c.back_word)
        .sort(() => 0.5 - Math.random())
        .slice(0, 3);
      const options = [...distractors, correct].sort(() => 0.5 - Math.random());
      return { id: idx, text: card.front_word, options, answer: options.indexOf(correct) };
    });

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
  });

  socket.on('join_room', (roomID) => {
    const room = rooms[roomID];
    if (room && room.players.length < 2) {
      room.players.push(socket.id);
      socket.join(roomID);
      io.to(roomID).emit('game_start', { question: room.questions[0], duration: QUESTION_DURATION });
      startTimer(roomID);
      broadcastRooms();
    }
  });

  socket.on('submit_answer_simple', ({ answerIndex }) => {
    const roomID = Array.from(socket.rooms).find(r => rooms[r]);
    if (!roomID) return;
    const room = rooms[roomID];

    if (!room.answeredPlayers.includes(socket.id)) room.answeredPlayers.push(socket.id);

    if (answerIndex !== room.questions[room.currentQuestionIndex].answer) {
      if (room.timer) clearTimeout(room.timer);
      socket.emit('game_over', { result: 'lose' });
      room.players.filter(id => id !== socket.id).forEach(id => io.to(id).emit('game_over', { result: 'win' }));
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
        } else {
          io.to(roomID).emit('next_question', { question: room.questions[room.currentQuestionIndex], duration: QUESTION_DURATION });
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

httpServer.listen(3000, '0.0.0.0', () => console.log('🚀 Sunucu Hazır: 3000'));