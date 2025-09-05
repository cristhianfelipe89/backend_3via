const { Schema, model } = require("mongoose");

const QuestionSchema = new Schema({
    category: { type: String, required: true, index: true },
    statement: { type: String, required: true },
    options: { type: [String], validate: v => v.length >= 2 },
    correctIndex: { type: Number, required: true }
}, { timestamps: true });

module.exports = model("Question", QuestionSchema);