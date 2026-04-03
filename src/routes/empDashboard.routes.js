const express = require('express');
const router  = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/empDashboard.controller');

// All routes: any authenticated employee
router.use(authenticate);

router.get('/summary',             ctrl.getSummary);
router.get('/profile',             ctrl.getProfile);
router.put('/profile',             ctrl.updateProfile);
router.post('/punch',              ctrl.punch);
router.get('/attendance-history',  ctrl.getAttendanceHistory);

module.exports = router;