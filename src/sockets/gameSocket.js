// gameSocket.js (versión corregida y compatible con tu original)
const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");
const Game = require("../models/Game");
const Question = require("../models/Question");
const AnswerLog = require("../models/AnswerLog");

const MIN = Number(process.env.MIN_PLAYERS || 2);
const MAX = Number(process.env.MAX_PLAYERS || 4);
const QTIME = Number(process.env.QUESTION_TIME_MS || 10000);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 15000);
const BETWEEN_ROUNDS_DELAY_MS = Number(process.env.BETWEEN_ROUNDS_DELAY_MS || 5000);

// timers
const startTimers = new Map();   // gameId -> timeoutId (start)
const lobbyMembers = new Map();  // gameId -> Set<userId>

// ahora roundTimers guarda { timeoutId, intervalId, endsAt }
const roundTimers = new Map();   // gameId -> { timeoutId, intervalId, endsAt }

/** Generar código de juego */
function generateGameCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** Middleware de autenticación para sockets */
function socketAuthMiddleware(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
}

/** Helper: limpia timers de ronda */
function clearRoundTimers(gameId) {
  const t = roundTimers.get(String(gameId));
  if (!t) return;
  try { clearTimeout(t.timeoutId); } catch (e) {}
  try { clearInterval(t.intervalId); } catch (e) {}
  roundTimers.delete(String(gameId));
}

/** Helper: emitir timer tick inmediatamente y cada segundo */
function startRoundTimerTicks(io, gameId) {
  // limpiar si existía
  clearRoundTimers(gameId);

  const endsAt = Date.now() + QTIME;
  // primer tick inmediato
  io.to(gameId).emit("game:timer", { remainingMs: QTIME, endsAt });

  // intervalo cada segundo
  const intervalId = setInterval(() => {
    const remaining = Math.max(0, endsAt - Date.now());
    // si se acabó, el timeout principal lo manejará; aun así mandamos 0 si llega a 0
    io.to(gameId).emit("game:timer", { remainingMs: remaining, endsAt });
    if (remaining <= 0) {
      // eliminar intervalo localmente (timeout hará la lógica de cierre)
      try { clearInterval(intervalId); } catch (e) {}
    }
  }, 1000);

  // timeout para cerrar la ronda
  const timeoutId = setTimeout(async () => {
    try {
      // cargar question desde la DB en endRound si hace falta
      const game = await Game.findById(gameId);
      const round = game?.rounds?.at(-1);
      let qDoc = null;
      if (round && round.question) {
        qDoc = await Question.findById(round.question);
      }
      // limpiar interval
      try { clearInterval(intervalId); } catch (e) {}
      roundTimers.delete(String(gameId));
      // llamar endRound (maneja guardado y siguiente ronda)
      await endRound(io, String(gameId), qDoc);
    } catch (err) {
      console.error("[round timeout] error:", err);
      roundTimers.delete(String(gameId));
    }
  }, QTIME);

  roundTimers.set(String(gameId), { timeoutId, intervalId, endsAt });
}

/** gameSocket principal */
function gameSocket(io, socket) {

  // Unirse al lobby
  socket.on("lobby:join", async () => {
    try {
      const userId = new Types.ObjectId(socket.user.id);
      let running = await Game.findOne({ status: "running", "players.user": userId });

      if (running) {
        // Reconexión: actualizar socketId del jugador si ya estaba en partida
        await Game.updateOne(
          { _id: running._id, "players.user": userId },
          { $set: { "players.$.socketId": socket.id } }
        );
        socket.join(String(running._id));
        socket.emit("game:start", { gameId: String(running._id) });

        // Si estaba en ronda activa, reenviar pregunta/tiempo si aplica
        const last = running.rounds.at(-1);
        if (last && !last.endedAt && last.question) {
          const q = await Question.findById(last.question);
          if (q) {
            socket.emit("game:question", {
              id: String(q._id),
              statement: q.statement,
              options: q.options,
              category: q.category,
              timeMs: QTIME
            });

            // Si hay timer corriendo en el server para esta partida, reenviar remainingMs calculado
            const timers = roundTimers.get(String(running._id));
            if (timers && timers.endsAt) {
              const remaining = Math.max(0, timers.endsAt - Date.now());
              socket.emit("game:timer", { remainingMs: remaining, endsAt: timers.endsAt });
            } else {
              socket.emit("game:timer", { remainingMs: QTIME, endsAt: Date.now() + QTIME });
            }
          }
        }

        // si el jugador ya está eliminado -> avisar para que muestre "perdiste"
        const me = running.players.find(p => String(p.user) === String(userId));
        if (me && me.eliminated) {
          socket.emit("game:status", { status: "perdiste" });
        }

        return;
      }

      // Cerrar duplicados del mismo usuario
      for (const [sid, s] of io.sockets.sockets) {
        if (sid !== socket.id && s.user?.id === socket.user.id) {
          try { s.disconnect(true); } catch {}
        }
      }

      // Eliminar rastro previo en juegos 'waiting'
      await Game.updateMany({ status: "waiting" }, { $pull: { players: { user: userId } } });

      // Buscar o crear juego WAITING
      let game = await Game.findOne({ status: "waiting" });
      if (!game) {
        try {
          game = await Game.create({ code: "WAITING" });
        } catch {
          game = await Game.findOne({ status: "waiting" });
        }
      }

      const key = String(game._id);
      if (!lobbyMembers.has(key)) lobbyMembers.set(key, new Set());
      const set = lobbyMembers.get(key);
      if (set.size >= MAX) {
        socket.emit("lobby:full");
        return;
      }

      set.add(String(userId));
      socket.join(game.id);

      // recargar y dedupe DB (igual que tenías)
      game = await Game.findById(game._id);
      const seen = new Set();
      const deduped = game.players.filter(p => {
        const k = String(p.user);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (deduped.length !== game.players.length) {
        await Game.updateOne({ _id: game._id, status: "waiting" }, { $set: { players: deduped } });
        game = await Game.findById(game._id);
      }

      const activeCount = set.size;
      io.to(game.id).emit("lobby:update", { count: activeCount, min: MIN, max: MAX });
      console.log(`[Lobby] game ${game.id} players=${activeCount}/${MIN}`);

      if (set.size >= MIN) {
        if (!startTimers.has(String(game.id)) && game.status === "waiting") {
          const timeoutId = setTimeout(async () => {
            startTimers.delete(String(game.id));
            await startGame(io, game.id);
          }, START_DELAY_MS);
          startTimers.set(String(game.id), timeoutId);
          io.to(game.id).emit("lobby:starting", { inMs: START_DELAY_MS, at: Date.now() + START_DELAY_MS });
        }
      }
    } catch (err) {
      console.error("[lobby:join] error:", err);
    }
  });

  // Responder pregunta
  socket.on("game:answer", async ({ gameId, questionId, optionIndex, tsClient }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== "running") return;

      const round = game.rounds.at(-1);
      if (!round || String(round.question) !== String(questionId) || round.endedAt) return;

      // Bloquear si el jugador está eliminado
      const player = game.players.find(p => String(p.user) === socket.user.id);
      if (!player) {
        socket.emit("game:rejected", { message: "No estás en la partida." });
        return;
      }
      if (player.eliminated) {
        socket.emit("game:rejected", { message: "No puedes responder, estás eliminado." });
        return;
      }

      // Evitar doble respuesta
      if (round.answered.find(a => String(a.user) === socket.user.id)) return;

      const q = await Question.findById(questionId);
      const correct = q && q.correctIndex === optionIndex;
      const latency = Date.now() - (tsClient || Date.now());

      round.answered.push({ user: socket.user.id, correct, timeMs: latency });

      if (player) {
        player.lastAnswer = { optionIndex, ts: Date.now(), correct: !!correct };
        if (correct) player.score = (player.score || 0) + 1;
      }

      await AnswerLog.create({ game: game._id, user: socket.user.id, question: q._id, correct, latencyMs: latency });
      await game.save();

      io.to(game.id).emit("game:roundUpdate", { answered: round.answered.length });

      // Si todos los vivos respondieron -> cerrar ronda inmediatamente
      const alivePlayers = game.players.filter(p => !p.eliminated);
      const aliveIds = alivePlayers.map(p => String(p.user));
      const answeredIds = new Set(round.answered.map(a => String(a.user)));

      if (aliveIds.length > 0 && aliveIds.every(uid => answeredIds.has(uid))) {
        // limpiar timers y cerrar ronda YA
        clearRoundTimers(gameId);
        await endRound(io, String(game._id), q);
      }
    } catch (err) {
      console.error("[game:answer] error:", err);
    }
  });

  // Disconnect: marcar eliminado si estaba en running (manteniendo tu lógica)
  socket.on("disconnect", async () => {
    try {
      const userId = String(socket.user?.id);
      // quitar del lobby en memoria
      for (const [gid, set] of lobbyMembers.entries()) {
        if (set.delete(userId)) {
          io.to(gid).emit("lobby:update", { count: set.size, min: MIN, max: MAX });
        }
      }

      // Si estaba en partida corriendo -> marcar eliminado y revisar ganador
      const game = await Game.findOne({ "players.user": userId, status: "running" });
      if (game) {
        const player = game.players.find(p => String(p.user) === userId);
        if (player) {
          player.eliminated = true;
          await game.save();

          io.to(game.id).emit("game:roundUpdate", {
            answered: game.rounds.at(-1)?.answered.length || 0,
            eliminated: [userId]
          });

          // avisar al socket en caso de reconexión no aplica; quien se desconectó perderá su socket
          // revisar si queda <=1
          const alive = game.players.filter(p => !p.eliminated);
          if (alive.length <= 1) {
            game.status = "finished";
            game.winner = alive[0]?.user || null;
            await game.save();

            // enviar ganador con nombre
            let winnerData = null;
            if (game.winner) {
              try {
                const User = require("../models/User");
                const u = await User.findById(game.winner).lean();
                if (u) winnerData = { id: u._id.toString(), name: u.name };
              } catch (err) {
                console.error("[disconnect] error loading winner user:", err);
              }
            }
            io.to(game.id).emit("game:finished", { winner: winnerData });
          }
        }
      }
    } catch (err) {
      console.error("[disconnect] error:", err);
    }
  });
}

/** Iniciar juego */
async function startGame(io, gameId) {
  const game = await Game.findById(gameId);
  if (!game) return;
  const key = String(game._id);
  const set = lobbyMembers.get(key) || new Set();
  const aliveCount = set.size;
  if (aliveCount < MIN) {
    io.to(game.id).emit("lobby:update", { count: aliveCount, min: MIN, max: MAX });
    console.log(`[Lobby] start aborted, not enough players (${aliveCount}/${MIN})`);
    return;
  }

  // Obtener socketIds actuales para los jugadores del lobby
  const players = [];
  for (const uid of set) {
    let socketId = null;
    for (const [sid, s] of io.sockets.sockets) {
      if (s.user?.id === uid) {
        socketId = sid;
        break;
      }
    }
    players.push({ user: uid, socketId, eliminated: false, score: 0 });
  }

  game.players = players;
  game.status = "running";
  if (game.code === "WAITING") game.code = generateGameCode();
  await game.save();
  lobbyMembers.delete(key);

  io.to(game.id).emit("game:start", { gameId: game.id });
  // lanzar primera ronda (usa nextRound)
  setTimeout(() => { nextRound(io, game.id); }, 300);
}

/** Iniciar nueva ronda */
async function nextRound(io, gameId) {
  const game = await Game.findById(gameId);
  if (!game || game.status !== "running") return;

  // comprobar ganador
  const alive = game.players.filter(p => !p.eliminated);
  if (alive.length <= 1) {
    const winnerId = alive[0]?.user || null;
    game.status = "finished";
    game.winner = winnerId;
    await game.save();

    let winnerData = null;
    if (winnerId) {
      try {
        const User = require("../models/User");
        const u = await User.findById(winnerId).lean();
        if (u) winnerData = { id: u._id.toString(), name: u.name };
      } catch (err) {
        console.error("[Game] Error cargando datos de usuario ganador:", err);
      }
    }

    io.to(game.id).emit("game:finished", { winner: winnerData });
    return;
  }

  // Cancelar cualquier temporizador viejo (timeout + interval)
  clearRoundTimers(gameId);

  // Selección aleatoria evitando últimas preguntas (puedes mantener tu lógica original si quieres)
  const LAST_ROUNDS_LIMIT = 3;
  const excludedQuestions = (game.lastQuestions || []).map(id => Types.ObjectId(id));
  let aggMatch = excludedQuestions.length ? { _id: { $nin: excludedQuestions } } : {};

  let qDoc = await Question.aggregate([{ $match: aggMatch }, { $sample: { size: 1 } }]);
  if (!qDoc.length) {
    qDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
    game.lastQuestions = [];
  }
  qDoc = qDoc[0];

  // guardar historial y anotar ronda
  game.lastQuestions = [...(game.lastQuestions || []), qDoc._id];
  if (game.lastQuestions.length > LAST_ROUNDS_LIMIT) game.lastQuestions.shift();

  game.rounds.push({ question: qDoc._id, startedAt: new Date(), answered: [] });
  await game.save();

  const payload = {
    id: String(qDoc._id),
    statement: qDoc.statement,
    options: qDoc.options,
    category: qDoc.category,
    timeMs: QTIME
  };

  // Emitir pregunta y tiempo a los vivos; eliminados reciben "game:waiting"
  for (const p of game.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) continue;
    if (!p.eliminated) {
      sock.emit("game:question", payload);
      // enviamos tick inmediato y luego cada segundo desde server
      // startRoundTimerTicks emite game:timer a todo el room
    } else {
      // si está eliminado: avisar que debe mostrar vista "perdiste" y esperar
      sock.emit("game:status", { status: "perdiste" });
      sock.emit("game:waiting", { message: "Estás eliminado. Espera a que termine la partida." });
    }
  }

  // iniciar ticks y timeout para la ronda (el método envía game:timer a todo el room)
  startRoundTimerTicks(io, String(game._id));
}

/** Terminar ronda */
async function endRound(io, gameId, q) {
  // limpiar timers por si algo quedó
  clearRoundTimers(gameId);

  const game = await Game.findById(gameId);
  if (!game) return;
  const round = game.rounds.at(-1);
  if (!round || round.endedAt) return;

  // asegurar pregunta cargada
  if (!q && round.question) {
    q = await Question.findById(round.question);
  }

  const answeredMap = new Map(round.answered.map(a => [String(a.user), !!a.correct]));

  // lógica corregida: si TODOS los vivos respondieron y TODOS respondieron CORRECTAMENTE -> nadie eliminado
  const vivos = game.players.filter(p => !p.eliminated);
  const vivosIds = vivos.map(p => String(p.user));
  const allAnswered = vivosIds.length > 0 && vivosIds.every(id => answeredMap.has(id));
  const allCorrect = allAnswered && vivosIds.every(id => answeredMap.get(id) === true);

  if (!allCorrect) {
    // Marcar eliminados: los que respondieron mal O los que no respondieron
    game.players.forEach(p => {
      const uid = String(p.user);
      if (!p.eliminated) {
        if (answeredMap.has(uid)) {
          if (!answeredMap.get(uid)) p.eliminated = true; // respondió mal
        } else {
          p.eliminated = true; // no respondió
        }
      }
    });
  } else {
    // todos respondieron correctamente -> no eliminar a nadie (puedes emitir un evento si quieres)
    // dejar p.eliminated como estaba (no hacemos cambios)
    console.log(`[Game] ronda: todos los vivos respondieron correctamente en gameId=${game.id}`);
  }

  // cerrar la ronda y guardar
  round.endedAt = new Date();
  await game.save();

  // construir arrays para el summary
  const eliminated = game.players.filter(p => p.eliminated).map(p => String(p.user));
  const alivePlayers = game.players.filter(p => !p.eliminated);
  const aliveCount = alivePlayers.length;

  // Notificar a los jugadores eliminados que muestren vista "perdiste"
  for (const p of game.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) continue;
    if (p.eliminated) {
      sock.emit("game:status", { status: "perdiste" });
      // opcional: enviar info de por qué (no respondió / respondió mal)
      // sock.emit("game:lost", { message: "Has perdido 😢" });
    } else {
      // jugadores vivos pueden recibir resumen y continuar
      sock.emit("game:status", { status: "active" });
    }
  }

  // Emitir resumen de ronda
  io.to(game.id).emit("game:roundSummary", {
    correctIndex: q ? q.correctIndex : null,
    eliminated,
    aliveCount,
    // opcional: puedes agregar roundId, endedAt, etc.
  });

  console.log(`[Game] round ended gameId=${game.id} q=${q? q._id : 'unknown'} eliminated=${eliminated.length} alive=${aliveCount}`);

  // Si solo queda uno → terminar la partida
  if (aliveCount <= 1) {
    game.status = "finished";
    game.winner = alivePlayers[0]?.user || null;
    await game.save();

    let winnerData = null;
    if (game.winner) {
      try {
        const User = require("../models/User");
        const u = await User.findById(game.winner).lean();
        if (u) winnerData = { id: u._id.toString(), name: u.name };
      } catch (err) {
        console.error("[endRound] Error cargando datos de usuario en roundSummary:", err);
      }
    }

    io.to(game.id).emit("game:finished", { winner: winnerData });
    return;
  }

  // Si quedan varios → siguiente ronda después de BETWEEN_ROUNDS_DELAY_MS
  setTimeout(async () => {
    try {
      await nextRound(io, game.id);
    } catch (err) {
      console.error("[endRound:setTimeout] error calling nextRound:", err);
    }
  }, BETWEEN_ROUNDS_DELAY_MS);
}

/** Terminar partida */
async function endGame(io, game) {
  const alive = game.players.filter(p => !p.eliminated);
  const winnerId = alive[0]?.user || null;
  game.status = "finished";
  game.winner = winnerId;
  await game.save();

  let winnerData = null;
  if (winnerId) {
    const User = require("../models/User");
    const user = await User.findById(winnerId).lean();
    if (user) winnerData = { id: user._id.toString(), name: user.name };
  }

  io.to(game.id).emit("game:finished", { winner: winnerData });
}

module.exports = { socketAuthMiddleware, gameSocket, endRound, nextRound };