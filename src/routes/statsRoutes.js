const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { onlyAdmin } = require("../middleware/roles");
const { overview } = require("../controllers/statsController");

router.get("/overview", requireAuth, onlyAdmin, overview);

module.exports = router;