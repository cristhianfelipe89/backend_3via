const mongoose = require("mongoose");

module.exports = async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ MongoDB conectado");
    } catch (e) {
        console.error("❌ Mongo error:", e.message);
        process.exit(1);
    }
};