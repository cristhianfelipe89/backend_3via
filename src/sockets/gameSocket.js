const jwt = require("jsonwebtoken");
const Game = require("../models/Game");
const Question = require("../models/Question");
const AnswerLog = require("../models/AnswerLog");

const MIN = Number(process.env.MIN_PLAYERS || 5);
const MAX = Number(process.env.MAX_PLAYERS || 100);
const QTIME = Number(process.env.QUESTION_TIME_MS || 5000);

/** Middleware de autenticación para sockets: espera token en `auth.token` */
function socketAuthMiddleware(socket, next) {
    try {
        const token = socket.handshake.auth?.token || null;
        if (!token) return next(new Error("No token"));
        const user = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = user; // { id, role, name }
        next();
    } catch {
        next(new Error("Invalid token"));
    }
}

/** Lógica principal de lobby/partida */
function gameSocket(io, socket) {
    // Unirse al lobby
    socket.on("lobby:join", async () => {
        let game = await Game.findOne({ status: "waiting" });
        if (!game) game = await Game.create({});

        // Si está lleno, avisa
        if (game.players.length >= MAX) {
            socket.emit("lobby:full");
            return;
        }

        // Evitar duplicados
        const exists = game.players.find(p => String(p.user) === socket.user.id);
        if (!exists) game.players.push({ user: socket.user.id, socketId: socket.id });
        await game.save();

        socket.join(game.id);
        io.to(game.id).emit("lobby:update", { count: game.players.length, min: MIN, max: MAX });

        if (game.players.length >= MIN) startGame(io, game.id);
    });

    // Responder pregunta
    socket.on("game:answer", async ({ gameId, questionId, optionIndex, tsClient }) => {
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
    });

    socket.on("disconnect", async () => {
        // Si un jugador se desconecta durante la partida, se marca eliminado
        const game = await Game.findOne({ "players.socketId": socket.id, status: { $in: ["waiting", "running"] } });
        if (!game) return;
        const p = game.players.find(x => x.socketId === socket.id);
        if (p) p.eliminated = true;
        await game.save();
    });
}

/** Arranque de la partida */
async function startGame(io, gameId) {
    const game = await Game.findById(gameId);
    if (!game) return;
    game.status = "running";
    await game.save();

    io.to(game.id).emit("game:start", { gameId: game.id });
    await nextRound(io, game);
}

/** Administración de rondas y fin de juego */
async function nextRound(io, game) {
    // ¿Queda ganador?
    const alive = game.players.filter(p => !p.eliminated);
    if (alive.length <= 1) {
        const winner = alive[0]?.user || null;
        game.status = "finished";
        game.winner = winner;
        await game.save();
        io.to(game.id).emit("game:finished", { winner });
        return;
    }

    // Elegir pregunta al azar
    const count = await Question.countDocuments();
    if (!count) { io.to(game.id).emit("game:error", { message: "No hay preguntas" }); return; }
    const skip = Math.floor(Math.random() * count);
    const q = await Question.findOne().skip(skip);

    game.rounds.push({ question: q._id, startedAt: new Date(), answered: [] });
    await game.save();

    io.to(game.id).emit("game:question", {
        id: String(q._id),
        statement: q.statement,
        options: q.options,
        category: q.category,
        timeMs: QTIME
    });

    // Cerrar ronda en QTIME ms
    setTimeout(async () => {
        const round = game.rounds.at(-1);
        const answeredIds = new Set(round.answered.map(a => String(a.user)));

        // Eliminar a quienes no respondieron
        game.players.forEach(p => { if (!answeredIds.has(String(p.user))) p.eliminated = true; });
        round.endedAt = new Date();
        await game.save();

        io.to(game.id).emit("game:roundSummary", {
            correctIndex: q.correctIndex,
            eliminated: game.players.filter(p => p.eliminated).map(p => p.user),
            aliveCount: game.players.filter(p => !p.eliminated).length
        });

        await nextRound(io, game);
    }, QTIME);
}

module.exports = { socketAuthMiddleware, gameSocket };