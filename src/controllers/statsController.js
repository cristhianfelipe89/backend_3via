const Game = require("../models/Game");
const AnswerLog = require("../models/AnswerLog");

async function overview(_, res) {
    const [played, winners, categories] = await Promise.all([
        Game.countDocuments({ status: "finished" }),
        Game.aggregate([
            { $match: { winner: { $ne: null } } },
            { $group: { _id: "$winner", wins: { $sum: 1 } } },
            { $sort: { wins: -1 } }, { $limit: 20 }
        ]),
        AnswerLog.aggregate([
            { $match: { correct: true } },
            { $lookup: { from: "questions", localField: "question", foreignField: "_id", as: "q" } },
            { $unwind: "$q" },
            { $group: { _id: "$q.category", hits: { $sum: 1 } } },
            { $sort: { hits: -1 } }
        ])
    ]);
    res.json({ played, winners, categories });
}

module.exports = { overview };