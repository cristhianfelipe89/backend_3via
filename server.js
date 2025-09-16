// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const User = require('./models/User');       // ver más abajo
const Question = require('./models/Question');
const Game = require('./models/Game');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // ajustar dominio en producción
});

// Conexión Mongo
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/trivia', {
  useNewUrlParser: true, useUnifiedTopology: true
}).then(()=> console.log('Mongo connected')).catch(console.error);

// --- LOBBY en memoria (simple) ---
const LOBBIES = {}; // { lobbyId: { players: [{id, socketId, username}], creatingGame: bool } }

// Helper: get random questions
async function getQuestions(count = 20, category = null) {
  const q = category ? { category } : {};
  return await Question.aggregate([{ $match: q }, { $sample: { size: count } }]);
}

function authSocket(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'secretkey'); // payload with user id, username
  } catch (e) {
    return null;
  }
}

// SOCKET.IO: namespace default
io.on('connection', socket => {
  console.log('Socket connected', socket.id);

  // Esperamos que el cliente emita 'join_lobby' con { token, lobbyId }
  socket.on('join_lobby', async ({ token, lobbyId='global' }) => {
    const payload = authSocket(token);
    if (!payload) {
      socket.emit('error_auth', 'Token inválido');
      socket.disconnect();
      return;
    }

    socket.data.user = { id: payload.id, username: payload.username || payload.email };
    socket.data.lobbyId = lobbyId;

    socket.join(lobbyId);
    LOBBIES[lobbyId] = LOBBIES[lobbyId] || { players: [], creatingGame:false };

    // Añadir si no existe
    if (!LOBBIES[lobbyId].players.find(p => p.id === payload.id)) {
      LOBBIES[lobbyId].players.push({ id: payload.id, socketId: socket.id, username: socket.data.user.username });
    } else {
      // actualizar socketId
      LOBBIES[lobbyId].players = LOBBIES[lobbyId].players.map(p => p.id === payload.id ? { ...p, socketId: socket.id } : p);
    }

    // Emitir lista actualizada a la sala
    io.to(lobbyId).emit('lobby_update', { players: LOBBIES[lobbyId].players.map(p => ({ id: p.id, username: p.username })) });
    console.log(`User ${socket.data.user.username} joined lobby ${lobbyId}`);

    // Si hay 5 o más y no hay partida en creación -> crear partida
    if (LOBBIES[lobbyId].players.length >= 5 && !LOBBIES[lobbyId].creatingGame) {
      LOBBIES[lobbyId].creatingGame = true;
      startGameForLobby(lobbyId).catch(err => {
        console.error('Error starting game:', err);
        LOBBIES[lobbyId].creatingGame = false;
      });
    }
  });

  socket.on('leave_lobby', () => {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId || !LOBBIES[lobbyId]) return;
    LOBBIES[lobbyId].players = LOBBIES[lobbyId].players.filter(p => p.socketId !== socket.id && p.id !== socket.data.user?.id);
    io.to(lobbyId).emit('lobby_update', { players: LOBBIES[lobbyId].players.map(p => ({ id: p.id, username: p.username })) });
  });

  socket.on('submit_answer', data => {
    // data: { gameId, questionIndex, answerIndex }
    const payload = socket.data.user;
    if (!payload) return;
    io.to(socket.data.lobbyId).emit('player_answer_submitted', { userId: payload.id, username: payload.username });
    socket.to(`game_${data.gameId}`).emit('player_answer_submitted', { userId: payload.id, username: payload.username });
    // The actual game logic will be in startGameForLobby which stores expected answers and waits for responses
    // But we keep this event for client ack.
  });

  socket.on('disconnect', () => {
    // eliminar del lobby si existe
    const lobbyId = socket.data.lobbyId;
    if (lobbyId && LOBBIES[lobbyId]) {
      LOBBIES[lobbyId].players = LOBBIES[lobbyId].players.filter(p => p.socketId !== socket.id);
      io.to(lobbyId).emit('lobby_update', { players: LOBBIES[lobbyId].players.map(p => ({ id: p.id, username: p.username })) });
    }
    console.log('Socket disconnected', socket.id);
  });
});

async function startGameForLobby(lobbyId) {
  const lobby = LOBBIES[lobbyId];
  if (!lobby) return;
  const players = [...lobby.players]; // snapshot
  console.log('Starting game for lobby', lobbyId, 'players', players.map(p=>p.username));

  // Crear documento Game en DB
  const questions = await getQuestions(50); // tomar 50 preguntas aleatorias
  const gameDoc = new Game({
    lobbyId,
    players: players.map(p => ({ userId: p.id, username: p.username, socketId: p.socketId })),
    questions: questions.map(q => ({ questionId: q._id, statement: q.statement, options: q.options, correctIndex: q.correctIndex })),
    status: 'in_progress',
    startedAt: new Date()
  });
  await gameDoc.save();

  const gameRoom = `game_${gameDoc._id}`;

  // Unir sockets a la room de juego
  for (const p of players) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.join(gameRoom);
  }

  // Emitir 'game_started' a la sala de lobby y game room
  io.to(lobbyId).emit('game_created', { gameId: gameDoc._id, players: gameDoc.players });

  // Game loop: rondas
  let activePlayers = new Map(gameDoc.players.map(p => [p.userId.toString(), { ...p, eliminated: false }]));
  let qIndex = 0;
  while (activePlayers.size > 1 && qIndex < gameDoc.questions.length) {
    const q = gameDoc.questions[qIndex];
    // enviar pregunta a room
    io.to(gameRoom).emit('question', { questionIndex: qIndex, statement: q.statement, options: q.options, time: 8 });
    console.log('Sent question', qIndex);

    // Esperar respuestas: recolectar en memoria
    const answers = new Map(); // userId -> answerIndex

    // Handler temporal para recibir respuestas via socket events 'answer_for_game'
    const answerHandler = (socket) => (payload) => {
      if (payload.gameId.toString() !== gameDoc._id.toString() || payload.questionIndex !== qIndex) return;
      const userId = socket.data.user.id.toString();
      if (!activePlayers.has(userId) || activePlayers.get(userId).eliminated) return;
      if (!answers.has(userId)) {
        answers.set(userId, payload.answerIndex);
        // Optionally broadcast progress
        io.to(gameRoom).emit('answer_received', { userId, username: socket.data.user.username });
      }
    };

    // Voluntarily we listen to a custom namespace event: 'answer' on the socket
    const onAnswer = (s) => s.on(`answer_${gameDoc._id}_${qIndex}`, (payload) => {
      const userId = s.data.user.id.toString();
      if (!activePlayers.has(userId) || activePlayers.get(userId).eliminated) return;
      if (!answers.has(userId)) answers.set(userId, payload.answerIndex);
    });

    // Since binding dynamic handlers to all sockets is messy, we'll implement a simpler approach:
    // We'll wait fixed time and rely on clients to emit 'submit_answer' with (gameId, questionIndex, answerIndex).
    // We'll collect submitted answers from a temporary store on the server using a Map keyed by gameId+questionIndex.
    // For simplicity in this sample, we'll use a short wait and ask clients to call 'submit_answer_server'.

    // Wait for `timeLimit` seconds
    const timeLimit = 8 * 1000;
    // Instead of the dynamic handler above, we'll listen to a generic event 'submit_answer_server'
    const responses = [];
    const submitHandler = (payload) => {
      try {
        if (payload.gameId.toString() !== gameDoc._id.toString()) return;
        if (payload.questionIndex !== qIndex) return;
        const uid = socketFromUserId(payload.userId);
        if (!uid) return;
        // prevent duplicates
      } catch (err) { }
    };

    // Simpler implementation: Wait timeLimit, then ask clients to have previously emitted 'submit_answer' event
    // We'll gather answers by iterating sockets in the room and ask them to emit via ack (this is robust and synchronous):
    const socketsInRoom = Array.from(io.sockets.adapter.rooms.get(gameRoom) || []).map(id => io.sockets.sockets.get(id)).filter(Boolean);
    // Ask every socket to send its answer via a callback (socket timeout if no response)
    const gatherAnswers = socketsInRoom.map(s => {
      return new Promise(resolve => {
        s.timeout(timeLimit - 100).emit('request_answer', { gameId: gameDoc._id, questionIndex: qIndex }, (err, resp) => {
          if (err || !resp) return resolve({ socket: s, answer: null });
          return resolve({ socket: s, answer: resp.answerIndex });
        });
      });
    });
    const gathered = await Promise.all(gatherAnswers);

    // Evaluate answers and mark eliminated
    const eliminated = [];
    gathered.forEach(entry => {
      const s = entry.socket;
      const uid = s?.data?.user?.id?.toString();
      const ans = entry.answer;
      if (!uid) return;
      const correct = (ans === q.correctIndex);
      if (!correct) {
        if (activePlayers.has(uid)) {
          activePlayers.get(uid).eliminated = true;
          eliminated.push({ userId: uid, username: s.data.user.username });
        }
      }
    });

    // Broadcast round result
    io.to(gameRoom).emit('round_result', { questionIndex: qIndex, eliminated, remaining: Array.from(activePlayers.values()).filter(p => !p.eliminated).map(p => ({ userId: p.userId, username: p.username })) });

    // Persist partial results to DB
    gameDoc.rounds.push({
      questionIndex: qIndex,
      questionId: q.questionId,
      eliminated,
      responses: gathered.map(g => ({ userId: g.socket?.data?.user?.id, answer: g.answer }))
    });
    await gameDoc.save();

    // Remove eliminated players from activePlayers map
    for (const e of eliminated) activePlayers.delete(e.userId.toString());

    qIndex++;
    // Small pause between rounds
    await new Promise(r => setTimeout(r, 1500));
  }

  // Determinar ganador
  const remaining = Array.from(activePlayers.values()).filter(p => !p.eliminated);
  const winner = remaining.length === 1 ? remaining[0] : null;

  gameDoc.status = 'finished';
  gameDoc.endedAt = new Date();
  if (winner) {
    gameDoc.winner = { userId: winner.userId, username: winner.username };
  }
  await gameDoc.save();

  io.to(gameRoom).emit('game_over', { winner: gameDoc.winner, gameId: gameDoc._id });
  // Limpiar lobby: quitar los players que participaron (o vaciar)
  LOBBIES[lobbyId].players = LOBBIES[lobbyId].players.filter(p => !players.find(pp => pp.id === p.id));
  LOBBIES[lobbyId].creatingGame = false;
}

function socketFromUserId(userId) {
  // find socket by userId in active sockets
  for (const [id, s] of io.sockets.sockets) {
    if (s.data.user && s.data.user.id.toString() === userId.toString()) return s;
  }
  return null;
}

// Minimal REST API to fetch games/dashboard
app.get('/api/games/:id', async (req, res) => {
  const g = await Game.findById(req.params.id);
  if (!g) return res.status(404).send({ error: 'Not found' });
  res.send(g);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening ${PORT}`));
