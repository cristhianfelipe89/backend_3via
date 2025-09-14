const Game = require("../models/Game");
const AnswerLog = require("../models/AnswerLog");
const User = require("../models/User"); // importa el modelo de usuario

async function overview(_, res) {
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
            { $lookup: { from: "questions", localField: "question", foreignField: "_id", as: "q" } },
            { $unwind: "$q" },
            { $group: { _id: "$q.category", hits: { $sum: 1 } } },
            { $sort: { hits: -1 } }
        ])
    ]);

    // Mapear ganadores con nombre del usuario
    const winnerIds = winnersRaw.map(w => w._id);
    const users = await User.find({ _id: { $in: winnerIds } }, "name username");
    const usersMap = Object.fromEntries(users.map(u => [u._id.toString(), u.name || u.username]));

    const winners = winnersRaw.map(w => ({
        user: usersMap[w._id.toString()] || w._id,
        wins: w.wins
    }));

    res.json({ played, winners, categories });
}

module.exports = { overview };