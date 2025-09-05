const jwt = require("jsonwebtoken");

function sign(payload, expiresIn = "7d") {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function verify(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { sign, verify };