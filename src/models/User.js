const { Schema, model } = require("mongoose");

const UserSchema = new Schema({
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["player", "admin"], default: "player" },
    createdAt: { type: Date, default: Date.now }
});

module.exports = model("User", UserSchema);