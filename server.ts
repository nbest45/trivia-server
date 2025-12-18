import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';

// --- TİP TANIMLAMALARI ---
interface Question {
  id: number;
  text: string;
  options: string[];
  answer: number;
}

interface Room {
  players: string[];
  currentQuestionIndex: number;
  answeredPlayers: string[];
  timer: NodeJS.Timeout | null;
}

// --- VERİLER VE AYARLAR ---
const QUESTIONS: Question[] = [
  { id: 1, text: "Türkiye'nin başkenti neresidir?", options: ["İstanbul", "Ankara", "İzmir", "Bursa"], answer: 1 },
  { id: 2, text: "Hangi gezegen Kızıl Gezegen olarak bilinir?", options: ["Mars", "Venüs", "Jüpiter", "Satürn"], answer: 0 },
];

const QUESTION_DURATION = 10;
const rooms: Record<string, Room> = {}; // Oda ID'sine göre odaları tutar

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" } // Mobil bağlantı için CORS izni
});

// --- YARDIMCI FONKSİYONLAR ---

// Oyuncunun hangi odada olduğunu bulur
const findRoomByPlayerId = (playerId: string): string | null => {
  for (const roomID in rooms) {
    if (rooms[roomID].players.includes(playerId)) return roomID;
  }
  return null;
};

const startTimer = (roomID: string) => {
  const room = rooms[roomID];
  if (!room) return;

  if (room.timer) clearTimeout(room.timer);

  room.timer = setTimeout(() => {
    const losers = room.players.filter(p => !room.answeredPlayers.includes(p));
    const winners = room.players.filter(p => room.answeredPlayers.includes(p));

    if (losers.length > 0) {
      losers.forEach(id => io.to(id).emit('game_over', { result: 'time_out' }));
      winners.forEach(id => io.to(id).emit('game_over', { result: 'win_enemy_timeout' }));
      if (winners.length === 0) io.to(roomID).emit('game_over', { result: 'draw_timeout' });
      delete rooms[roomID];
    }
  }, QUESTION_DURATION * 1000);
};

// --- SOCKET MANTIĞI ---

io.on('connection', (socket: Socket) => {
  console.log('Bağlandı:', socket.id);

  socket.on('find_game', () => {
    let roomID: string | null = null;

    // Uygun oda ara
    for (const id in rooms) {
      if (rooms[id].players.length < 2) {
        roomID = id;
        break;
      }
    }

    // Oda yoksa oluştur
    if (!roomID) {
      roomID = Math.random().toString(36).substring(7);
      rooms[roomID] = {
        players: [],
        currentQuestionIndex: 0,
        answeredPlayers: [],
        timer: null
      };
    }

    socket.join(roomID);
    rooms[roomID].players.push(socket.id);

    if (rooms[roomID].players.length === 2) {
      io.to(roomID).emit('game_start', {
        question: QUESTIONS[0],
        duration: QUESTION_DURATION
      });
      startTimer(roomID);
    }
  });

  socket.on('submit_answer_simple', ({ answerIndex }: { answerIndex: number }) => {
    const roomID = findRoomByPlayerId(socket.id);
    if (!roomID || !rooms[roomID]) return;

    const room = rooms[roomID];
    const currentQ = QUESTIONS[room.currentQuestionIndex];

    if (!room.answeredPlayers.includes(socket.id)) {
      room.answeredPlayers.push(socket.id);
    }

    // Yanlış cevap kontrolü
    if (answerIndex !== currentQ.answer) {
      if (room.timer) clearTimeout(room.timer);
      socket.emit('game_over', { result: 'lose' });
      const winner = room.players.find(id => id !== socket.id);
      if (winner) io.to(winner).emit('game_over', { result: 'win' });
      delete rooms[roomID];
    } else {
      // Doğru cevap
      if (room.answeredPlayers.length === 1) {
        socket.emit('waiting_opponent');
      } else if (room.answeredPlayers.length === 2) {
        // İkisi de doğru bildi
        if (room.timer) clearTimeout(room.timer);
        room.answeredPlayers = [];
        room.currentQuestionIndex++;

        if (room.currentQuestionIndex >= QUESTIONS.length) {
          io.to(roomID).emit('game_over', { result: 'draw' });
          delete rooms[roomID];
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

  socket.on('disconnect', () => {
    const roomID = findRoomByPlayerId(socket.id);
    if (roomID) {
      io.to(roomID).emit('game_over', { result: 'opponent_left' });
      if (rooms[roomID].timer) clearTimeout(rooms[roomID].timer!);
      delete rooms[roomID];
    }
  });
});

const PORT = 3000;

httpServer.listen(3000, '0.0.0.0', () => {
  console.log('🚀 Sunucu TÜM AĞA AÇIK şekilde çalışıyor: 3000');
});