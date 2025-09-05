const { Schema, model, Types } = require("mongoose");

const AnswerLogSchema = new Schema({
    game: { type: Types.ObjectId, ref: "Game" },
    user: { type: Types.ObjectId, ref: "User" },
    question: { type: Types.ObjectId, ref: "Question" },
    correct: Boolean,
    latencyMs: Number,
    createdAt: { type: Date, default: Date.now }
});

module.exports = model("AnswerLog", AnswerLogSchema);