const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { onlyAdmin } = require("../middleware/roles");
const { listUsers, createUser } = require("../controllers/usersController");

router.get("/", requireAuth, onlyAdmin, listUsers);
router.post("/", requireAuth, onlyAdmin, createUser);

module.exports = router;