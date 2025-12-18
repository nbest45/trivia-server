import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';

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
  currentQuestionIndex: number;
  answeredPlayers: string[];
  timer: NodeJS.Timeout | null;
  isStarted: boolean;
}

const QUESTIONS: Question[] = [
  { id: 1, text: "Türkiye'nin başkenti neresidir?", options: ["İstanbul", "Ankara", "İzmir", "Bursa"], answer: 1 },
  { id: 2, text: "Hangi gezegen Kızıl Gezegen olarak bilinir?", options: ["Mars", "Venüs", "Jüpiter", "Satürn"], answer: 0 },
];

const QUESTION_DURATION = 10;
const rooms: Record<string, Room> = {};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Aktif ve boş odaları tüm kullanıcılara yayınlar
const broadcastRooms = () => {
  const availableRooms = Object.values(rooms)
    .filter(r => !r.isStarted && r.players.length < 2)
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
  console.log('Bağlandı:', socket.id);
  broadcastRooms(); // Yeni bağlanana listeyi gönder

  // YENİ: Oda Oluşturma
  socket.on('create_room', (roomName: string) => {
    const roomID = Math.random().toString(36).substring(7);
    rooms[roomID] = {
      id: roomID,
      name: roomName || `${socket.id.substring(0, 5)}'in Odası`,
      players: [socket.id],
      currentQuestionIndex: 0,
      answeredPlayers: [],
      timer: null,
      isStarted: false
    };
    socket.join(roomID);
    socket.emit('room_created', roomID);
    broadcastRooms();
  });

  // YENİ: Odalara Katılma
  socket.on('join_room', (roomID: string) => {
    const room = rooms[roomID];
    if (room && room.players.length < 2) {
      room.players.push(socket.id);
      socket.join(roomID);
      room.isStarted = true;
      
      io.to(roomID).emit('game_start', {
        question: QUESTIONS[0],
        duration: QUESTION_DURATION
      });
      startTimer(roomID);
      broadcastRooms();
    }
  });

  socket.on('submit_answer_simple', ({ answerIndex }: { answerIndex: number }) => {
    // Oyuncunun bağlı olduğu odayı manuel olarak bulalım
    let roomID = null;
    for (const id in rooms) {
      if (rooms[id].players.includes(socket.id)) {
        roomID = id;
        break;
      }
    }
  
    if (!roomID || !rooms[roomID]) return;
  
    const room = rooms[roomID];
    const currentQ = QUESTIONS[room.currentQuestionIndex];
  
    // Eğer oyuncu zaten cevap verdiyse işlem yapma
    if (room.answeredPlayers.includes(socket.id)) return;
    room.answeredPlayers.push(socket.id);
  
    // Yanlış cevap kontrolü
    if (answerIndex !== currentQ.answer) {
      if (room.timer) clearTimeout(room.timer);
      socket.emit('game_over', { result: 'lose' });
      const winner = room.players.find(id => id !== socket.id);
      if (winner) io.to(winner).emit('game_over', { result: 'win' });
      
      delete rooms[roomID];
      broadcastRooms();
    } else {
      // Doğru cevap
      if (room.answeredPlayers.length === 1) {
        socket.emit('waiting_opponent');
      } else if (room.answeredPlayers.length === 2) {
        // İkisi de doğru bildi -> Sonraki soruya geç
        if (room.timer) clearTimeout(room.timer);
        room.answeredPlayers = [];
        room.currentQuestionIndex++;
      
        if (room.currentQuestionIndex >= QUESTIONS.length) {
          io.to(roomID).emit('game_over', { result: 'draw' });
          delete rooms[roomID];
          broadcastRooms();
        } else {
          io.to(roomID).emit('next_question', {
            question: QUESTIONS[room.currentQuestionIndex],
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
      if (rooms[roomID].timer) clearTimeout(rooms[roomID].timer!);
      delete rooms[roomID];
      broadcastRooms();
    }
  });
});

httpServer.listen(3000, '0.0.0.0', () => console.log('🚀 Lobi Sistemi Aktif: 3000'));