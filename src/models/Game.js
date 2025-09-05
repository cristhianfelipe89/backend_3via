const { Schema, model, Types } = require("mongoose");

const PlayerSchema = new Schema({
    user: { type: Types.ObjectId, ref: "User", required: true },
    socketId: String,
    eliminated: { type: Boolean, default: false },
    score: { type: Number, default: 0 }
});

const RoundSchema = new Schema({
    question: { type: Types.ObjectId, ref: "Question" },
    startedAt: Date,
    endedAt: Date,
    answered: [{
        user: { type: Types.ObjectId, ref: "User" },
        correct: Boolean,
        timeMs: Number
    }]
});

const GameSchema = new Schema({
    code: { type: String, unique: true },
    status: { type: String, enum: ["waiting", "running", "finished"], default: "waiting" },
    players: [PlayerSchema],
    minPlayers: { type: Number, default: Number(process.env.MIN_PLAYERS) || 5 },
    maxPlayers: { type: Number, default: Number(process.env.MAX_PLAYERS) || 100 },
    winner: { type: Types.ObjectId, ref: "User" },
    rounds: [RoundSchema]
}, { timestamps: true });

module.exports = model("Game", GameSchema);