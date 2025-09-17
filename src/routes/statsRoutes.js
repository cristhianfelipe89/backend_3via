const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { onlyAdmin } = require("../middleware/roles");
const { overview, top5Winners } = require("../controllers/statsController");

router.get("/overview", requireAuth, onlyAdmin, overview);
router.get("/top5", requireAuth, onlyAdmin, top5Winners);

module.exports = router;