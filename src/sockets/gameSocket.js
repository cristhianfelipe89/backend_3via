// gameSocket.js (versión corregida)

const jwt = require("jsonwebtoken");
const { Types } = require("mongoose");
const Game = require("../models/Game");
const Question = require("../models/Question");
const AnswerLog = require("../models/AnswerLog");

const MIN = Number(process.env.MIN_PLAYERS || 2);
const MAX = Number(process.env.MAX_PLAYERS || 4);
const QTIME = Number(process.env.QUESTION_TIME_MS || 10000);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 15000);
const BETWEEN_ROUNDS_DELAY_MS = Number(process.env.BETWEEN_ROUNDS_DELAY_MS || 8000);

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
        if (!token) return next(new Error("No token"));
        const user = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = user; // { id, role, name }
        next();
    } catch (err) {
        next(new Error("Invalid token"));
    }
}

console.log("[GameSocket] Config:", { MIN, MAX, QTIME, START_DELAY_MS, BETWEEN_ROUNDS_DELAY_MS });

async function pruneWaitingPlayers() { /* no-op */ }

/** gameSocket: registra handlers por socket */
function gameSocket(io, socket) {
    // Unirse al lobby
    socket.on("lobby:join", async () => {
        try {
            const userId = new Types.ObjectId(socket.user.id);
            let running = await Game.findOne({ status: "running", "players.user": userId });

            if (running) {
                await Game.updateOne(
                    { _id: running._id, status: "running", "players.user": userId },
                    { $set: { "players.$.socketId": socket.id } }
                );
                socket.join(String(running._id));
                socket.emit("game:start", { gameId: String(running._id) });

                const last = running.rounds.at(-1);
                if (last && !last.endedAt && last.question) {
                    const q = await Question.findById(last.question);
                    if (q) {
                        // enviar SOLO a este socket (reconnect)
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

            // Cerrar otras conexiones duplicadas del mismo usuario
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

            // recargar y dedupe DB
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
            if (!round || String(round.question) !== String(questionId)) return;

            // Evitar doble respuesta
            if (round.answered.find(a => String(a.user) === socket.user.id)) return;

            const q = await Question.findById(questionId);
            const correct = q && q.correctIndex === optionIndex;
            const latency = Date.now() - (tsClient || Date.now());

            round.answered.push({ user: socket.user.id, correct, timeMs: latency });

            const player = game.players.find(p => String(p.user) === socket.user.id);
            if (player) {
                if (correct) player.score = (player.score || 0) + 1;
                else player.eliminated = true; // marcamos al instante (opción A)
                // opcional: guardar lastAnswer si usas estrategia B
                player.lastAnswer = { optionIndex, ts: Date.now(), correct: !!correct };
            }

            await AnswerLog.create({ game: game._id, user: socket.user.id, question: q._id, correct, latencyMs: latency });
            await game.save();

            io.to(game.id).emit("game:roundUpdate", { answered: round.answered.length });

            // Si todos los vivos ya respondieron -> cerrar ronda inmediatamente
            const aliveIds = game.players.filter(p => !p.eliminated).map(p => String(p.user));
            const answeredIds = new Set(round.answered.map(a => String(a.user)));

            if (aliveIds.length > 0 && aliveIds.every(uid => answeredIds.has(uid))) {
                console.log(`[Game] Todos los vivos respondieron en gameId=${game.id}, cerrando ronda`);
                await endRound(io, String(game._id), q);
            }
        } catch (err) {
            console.error("[game:answer] error:", err);
        }
    });

    // Disconnect
    socket.on("disconnect", async () => {
        try {
            const userId = String(socket.user?.id);
            // quitar del lobby en memoria
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

                io.to(game.id).emit("game:roundUpdate", {
                    answered: game.rounds.at(-1)?.answered.length || 0,
                    eliminated: [userId]
                });

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
                            const user = await User.findById(game.winner).lean();
                            if (user) winnerData = { id: user._id.toString(), name: user.name };
                        } catch (err) {
                            console.error("[disconnect] error loading winner user:", err);
                        }
                    }
                    io.to(game.id).emit("game:finished", { winner: winnerData });
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
    console.log(`[Game] start gameId=${game.id}`);
    setTimeout(() => { nextRound(io, game.id); }, 300);
}

/** nextRound: elige pregunta y la envía SOLO a jugadores vivos */
async function nextRound(io, gameId) {
    // Recargar estado
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
                if (user) winnerData = { id: user._id.toString(), name: user.name };
            } catch (err) {
                console.error("[Game] Error cargando datos de usuario ganador:", err);
            }
        }

        io.to(game.id).emit("game:finished", { winner: winnerData });
        return;
    }

    // Selección aleatoria evitando últimas preguntas (LAST_ROUNDS_LIMIT)
    const LAST_ROUNDS_LIMIT = 3;
    const excludedQuestions = (game.lastQuestions || []).map(id => Types.ObjectId(id));

    let aggMatch = { };
    if (excludedQuestions.length) aggMatch = { _id: { $nin: excludedQuestions } };

    let qDoc = await Question.aggregate([
        { $match: aggMatch },
        { $sample: { size: 1 } }
    ]);

    if (!qDoc.length) {
        // fallback: tomar cualquiera
        qDoc = await Question.aggregate([{ $sample: { size: 1 } }]);
        game.lastQuestions = []; // resetear exclusiones si no hay suficientes preguntas
    }

    qDoc = qDoc[0];
    // guardar historial
    game.lastQuestions = [...(game.lastQuestions || []), qDoc._id];
    if (game.lastQuestions.length > LAST_ROUNDS_LIMIT) game.lastQuestions.shift();
    // anotar ronda
    game.rounds.push({ question: qDoc._id, startedAt: new Date(), answered: [] });
    await game.save();

    const payload = {
        id: String(qDoc._id),
        statement: qDoc.statement,
        options: qDoc.options,
        category: qDoc.category,
        timeMs: QTIME
    };

    // Enviar SOLO a jugadores vivos
    for (const p of game.players) {
        if (!p.eliminated && p.socketId) {
            const sock = io.sockets.sockets.get(p.socketId);
            if (sock) sock.emit("game:question", payload);
        }
    }

    console.log(`[Game] question gameId=${game.id} q=${qDoc._id}`);

    // Programar cierre de ronda: llamar a endRound después de QTIME
    setTimeout(async () => {
        try {
            await endRound(io, String(game._id), qDoc);
        } catch (err) {
            console.error("[nextRound:setTimeout] error calling endRound:", err);
        }
    }, QTIME);
}

/** endRound: cierra la ronda actual y decide eliminados/ganador */
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

    // map userId -> correct (true/false)
    const answeredMap = new Map(round.answered.map(a => [String(a.user), !!a.correct]));

    // marcar eliminados: los que respondieron mal O los que no respondieron
    game.players.forEach(p => {
        const uid = String(p.user);
        if (answeredMap.has(uid)) {
            if (!answeredMap.get(uid)) p.eliminated = true;
        } else {
            p.eliminated = true;
        }
    });

    for (const player of game.players) {
    if (player.eliminated) {
        try {
            io.to(player.socketId).emit("game:lost", {
                message: "Has perdido 😢",
            });
        } catch (err) {
            console.error("[endRound] error al enviar game:lost:", err);
        }
    }
}

    // cerrar la ronda y guardar
    round.endedAt = new Date();
    await game.save();

    // construir arrays para el summary
    const eliminated = game.players.filter(p => p.eliminated).map(p => String(p.user));
    const alivePlayers = game.players.filter(p => !p.eliminated);
    const aliveCount = alivePlayers.length;

    // si queda exactamente 1 vivo -> buscar su nombre para enviar al front
    let winnerData = null;
    if (aliveCount === 1) {
        const winnerId = String(alivePlayers[0].user);
        try {
            const User = require("../models/User");
            const user = await User.findById(winnerId).lean();
            if (user) winnerData = { id: user._id.toString(), name: user.name };
        } catch (err) {
            console.error("[endRound] Error cargando datos de usuario en roundSummary:", err);
        }
    }

    // Emitir resumen de ronda (incluye winner si aplica)
    io.to(game.id).emit("game:roundSummary", {
        correctIndex: q ? q.correctIndex : null,
        eliminated,
        aliveCount,
        winner: winnerData
    });

    console.log(`[Game] round ended gameId=${game.id} q=${q? q._id : 'unknown'} eliminated=${eliminated.length} alive=${aliveCount}`);

    // Si solo queda uno → terminar la partida
    if (aliveCount <= 1) {
        game.status = "finished";
        game.winner = alivePlayers[0]?.user || null;
        await game.save();

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

module.exports = { socketAuthMiddleware, gameSocket, endRound };
