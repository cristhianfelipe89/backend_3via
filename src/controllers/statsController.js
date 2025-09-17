const Game = require("../models/Game");
const AnswerLog = require("../models/AnswerLog");
const User = require("../models/User");

// Estadísticas generales
async function overview(_, res) {
    try {
        const [played, winnersRaw, categories] = await Promise.all([
            Game.countDocuments({ status: "finished" }),

            Game.aggregate([
                { $match: { winner: { $ne: null } } },
                { $group: { _id: "$winner", wins: { $sum: 1 } } },
                { $sort: { wins: -1 } },
                { $limit: 20 }
            ]),

            AnswerLog.aggregate([
                { $match: { correct: true } },
                {
                    $lookup: {
                        from: "questions",
                        localField: "question",
                        foreignField: "_id",
                        as: "q"
                    }
                },
                { $unwind: "$q" },
                { $group: { _id: "$q.category", hits: { $sum: 1 } } },
                { $sort: { hits: -1 } }
            ])
        ]);

        const winnerIds = winnersRaw.map((w) => w._id);
        const users = await User.find(
            { _id: { $in: winnerIds } },
            "name username"
        );
        const usersMap = Object.fromEntries(
            users.map((u) => [u._id.toString(), u.name || u.username])
        );

        const winners = winnersRaw.map((w) => ({
            user: usersMap[w._id.toString()] || w._id,
            wins: w.wins
        }));

        res.json({ played, winners, categories });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al obtener estadísticas" });
    }
}

// NUEVA FUNCIÓN TOP 5 GANADORES
async function top5Winners(req, res) {
    try {
        const winnersRaw = await Game.aggregate([
            { $match: { winner: { $ne: null } } },
            { $group: { _id: "$winner", wins: { $sum: 1 } } },
            { $sort: { wins: -1 } },
            { $limit: 5 }
        ]);

        const winnerIds = winnersRaw.map((w) => w._id);
        const users = await User.find(
            { _id: { $in: winnerIds } },
            "name username"
        );
        const usersMap = Object.fromEntries(
            users.map((u) => [u._id.toString(), u.name || u.username])
        );

        const winners = winnersRaw.map((w) => ({
            name: usersMap[w._id.toString()] || "Jugador",
            wins: w.wins
        }));

        res.json(winners);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al obtener top5" });
    }
}

module.exports = { overview, top5Winners };