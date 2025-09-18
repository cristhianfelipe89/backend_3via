// gameSocket.js (archivo completo corregido)

const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");
const Game = require("../models/Game");
const Question = require("../models/Question");
const AnswerLog = require("../models/AnswerLog");

const MIN = Number(process.env.MIN_PLAYERS || 2); // ajustar
const MAX = Number(process.env.MAX_PLAYERS || 2);
const QTIME = Number(process.env.QUESTION_TIME_MS || 5000);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 15000);
const BETWEEN_ROUNDS_DELAY_MS = Number(process.env.BETWEEN_ROUNDS_DELAY_MS || 5000);

// Mapa en memoria para evitar múltiples arranques simultáneos
const startTimers = new Map(); // gameId -> timeoutId
const lobbyMembers = new Map(); // gameId -> Set<userId>

function generateGameCode(length = 6) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

/** Middleware de autenticación para sockets: espera token en `auth.token` */
function socketAuthMiddleware(socket, next) {
    try {
        const token = socket.handshake.auth?.token || null;
        if (!token) {
            console.log("[SocketAuth] No token recibido");
            return next(new Error("No token"));
        }
        const user = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = user; // { id, role, name }
        next();
    } catch (err) {
        console.log("[SocketAuth] Token inválido:", err.message);
        next(new Error("Invalid token"));
    }
}

console.log("[GameSocket] Config:", { MIN, MAX, QTIME, START_DELAY_MS, BETWEEN_ROUNDS_DELAY_MS });

// Limpieza agresiva deshabilitada; nos apoyamos en "disconnect" para limpiar.
async function pruneWaitingPlayers() { /* no-op */ }

/** Lógica principal de lobby/partida */
function gameSocket(io, socket) {
    // Unirse al lobby
    socket.on("lobby:join", async () => {
        try {
            // Reanudar si el usuario ya está en un juego corriendo
            const userId = new Types.ObjectId(socket.user.id);
            let running = await Game.findOne({ status: "running", "players.user": userId });
            if (running) {
                await Game.updateOne(
                    { _id: running._id, status: "running", "players.user": userId },
                    { $set: { "players.$.socketId": socket.id } }
                );
                socket.join(String(running._id));

                // Notificar solo a este socket que está en partida
                socket.emit("game:start", { gameId: String(running._id) });

                // Enviar la última pregunta si la ronda sigue abierta
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
                    }
                }
                return;
            }

            // Cerrar otras conexiones del mismo usuario (si las hay) para evitar duplicados
            for (const [sid, s] of io.sockets.sockets) {
                if (sid !== socket.id && s.user?.id === socket.user.id) {
                    try { s.disconnect(true); } catch {}
                }
            }

            // Eliminar cualquier rastro previo del usuario en juegos en espera
            await Game.updateMany({ status: "waiting" }, { $pull: { players: { user: userId } } });

            // Buscar un juego en espera o crear uno con código fijo "WAITING" para evitar duplicados
            let game = await Game.findOne({ status: "waiting" });
            if (!game) {
                try {
                    game = await Game.create({ code: "WAITING" });
                } catch {
                    // Si otro proceso lo creó, recuperarlo
                    game = await Game.findOne({ status: "waiting" });
                }
            }

            // Si está lleno, avisa
            const key = String(game._id);
            if (!lobbyMembers.has(key)) lobbyMembers.set(key, new Set());
            const set = lobbyMembers.get(key);
            if (set.size >= MAX) {
                socket.emit("lobby:full");
                return;
            }

            // Registrar en memoria al usuario en el lobby (no persistimos aún)
            set.add(String(userId));

            socket.join(game.id);
            // No hacer limpieza agresiva aquí para evitar falsos positivos
            game = await Game.findById(game._id);
            // Deduplicar por usuario por si Mongo estaba desincronizado (actualización atómica)
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
                // Si no hay un inicio programado, programar uno
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
            if (!round || String(round.question) !== String(questionId)) return;

            // Evitar doble respuesta
            if (round.answered.find(a => String(a.user) === socket.user.id)) return;

            const q = await Question.findById(questionId);
            const correct = q && q.correctIndex === optionIndex;
            const latency = Date.now() - (tsClient || Date.now());

            round.answered.push({ user: socket.user.id, correct, timeMs: latency });

            const player = game.players.find(p => String(p.user) === socket.user.id);
            if (player) {
                if (correct) player.score += 1;
                else player.eliminated = true;
            }

            await AnswerLog.create({ game: game._id, user: socket.user.id, question: q._id, correct, latencyMs: latency });
            await game.save();

            io.to(game.id).emit("game:roundUpdate", { answered: round.answered.length });

            // ✅ Si todos los vivos ya respondieron → cerrar ronda ya
            const aliveIds = game.players.filter(p => !p.eliminated).map(p => String(p.user));
            const answeredIds = new Set(round.answered.map(a => String(a.user)));

            if (aliveIds.length > 0 && aliveIds.every(uid => answeredIds.has(uid))) {
                // Llamar endRound con gameId para que recargue el estado y haga summary + siguiente ronda
                await endRound(io, String(game._id), q);
            }
        } catch (err) {
            console.error("[game:answer] error:", err);
        }
    });

    socket.on("disconnect", async () => {
        try {
            const userId = String(socket.user?.id);

            // Quitar del lobby en memoria
            for (const [gid, set] of lobbyMembers.entries()) {
                if (set.delete(userId)) {
                    io.to(gid).emit("lobby:update", { count: set.size, min: MIN, max: MAX });
                }
            }

            // Si estaba en partida corriendo
            const game = await Game.findOne({ "players.user": userId, status: "running" });
            if (game) {
                const player = game.players.find(p => String(p.user) === userId);
                if (player) player.eliminated = true;
                await game.save();

                // Notificar actualización inmediata
                io.to(game.id).emit("game:roundUpdate", {
                    answered: game.rounds.at(-1)?.answered.length || 0,
                    eliminated: [userId]
                });

                // Si ya solo queda uno vivo → terminar la partida
                const alive = game.players.filter(p => !p.eliminated);
                if (alive.length <= 1) {
                    game.status = "finished";
                    game.winner = alive[0]?.user || null;
                    await game.save();
                    io.to(game.id).emit("game:finished", { winner: game.winner });
                }
            }
        } catch (err) {
            console.error("[disconnect] error:", err);
        }
    });
}

/** Arranque de la partida */
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

    // Obtener los socketIds actuales de los jugadores en la sala
    const players = [];
    for (const uid of set) {
        // Buscar el socket activo para este usuario
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
    console.log(`[Game] start gameId=${game.id}`);
    setTimeout(() => { nextRound(io, game.id); }, 300);
}

/** Administración de rondas y fin de juego */
async function nextRound(io, gameId) {
    // Recargar siempre el estado más reciente
    const game = await Game.findById(gameId);
    if (!game) return;

    // ¿Queda ganador?
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
                const user = await User.findById(winnerId).lean();
                if (user) {
                    winnerData = { id: user._id, name: user.name, email: user.email };
                }
            } catch (err) {
                console.error("[Game] Error cargando datos de usuario ganador:", err);
            }
        }

        io.to(game.id).emit("game:finished", { winner: winnerData });
        return;
    }

    // Elegir pregunta al azar
    const count = await Question.countDocuments();
    if (!count) {
        io.to(game.id).emit("game:error", { message: "No hay preguntas disponibles. Vuelve al lobby." });
        game.status = "waiting";
        await game.save();
        return;
    }

    const skip = Math.floor(Math.random() * count);
    const q = await Question.findOne().skip(skip);

    game.rounds.push({ question: q._id, startedAt: new Date(), answered: [] });
    await game.save();

    const payload = {
        id: String(q._id),
        statement: q.statement,
        options: q.options,
        category: q.category,
        timeMs: QTIME
    };

    io.to(game.id).emit("game:question", payload);
    for (const p of game.players) {
        if (p.socketId) {
            const socket = io.sockets.sockets.get(p.socketId);
            if (socket) socket.emit("game:question", payload);
        }
    }

    console.log(`[Game] question gameId=${game.id} q=${q._id}`);

    // ⏳ Programar cierre de ronda: llamar a endRound después de QTIME
    setTimeout(async () => {
        try {
            await endRound(io, String(game._id), q);
        } catch (err) {
            console.error("[nextRound:setTimeout] error calling endRound:", err);
        }
    }, QTIME);
}

/**
 * endRound: cierra la ronda actual para un juego (se encarga de:
 *  - marcar no-respondedores como eliminados
 *  - fijar endedAt
 *  - emitir game:roundSummary
 *  - si quedan vivos -> programar siguiente ronda
 *  - si no quedan -> finalizar partida y emitir game:finished
 *
 * Recibe gameId (string) y el objeto pregunta q (soporta q==null => intenta obtener).
 */
async function endRound(io, gameId, q) {
    // recargar estado fresco
    const game = await Game.findById(gameId);
    if (!game) return;

    const round = game.rounds.at(-1);
    if (!round || round.endedAt) return;

    // asegurar pregunta cargada
    if (!q && round.question) {
        q = await Question.findById(round.question);
    }

    const answeredIds = new Set(round.answered.map(a => String(a.user)));

    // Eliminar a quienes no respondieron
    game.players.forEach(p => {
        if (!answeredIds.has(String(p.user))) p.eliminated = true;
    });

    round.endedAt = new Date();
    await game.save();

    // Emitir resumen de ronda (solo una vez)
    const eliminated = game.players.filter(p => p.eliminated).map(p => p.user);
    const aliveCount = game.players.filter(p => !p.eliminated).length;

    io.to(game.id).emit("game:roundSummary", {
        correctIndex: q ? q.correctIndex : null,
        eliminated,
        aliveCount
    });

    console.log(`[Game] round ended gameId=${game.id} q=${q? q._id : 'unknown'} eliminated=${eliminated.length} alive=${aliveCount}`);

    // Si solo queda uno → terminar
    const alive = game.players.filter(p => !p.eliminated);
    if (alive.length <= 1) {
        game.status = "finished";
        game.winner = alive[0]?.user || null;
        await game.save();
        io.to(game.id).emit("game:finished", { winner: game.winner });
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

module.exports = { socketAuthMiddleware, gameSocket, endRound };
