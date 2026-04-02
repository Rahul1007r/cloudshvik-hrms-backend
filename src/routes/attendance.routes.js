const express = require('express');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/attendance.controller');

const auth      = [authenticate];
const adminMgr  = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

// Employee self-service
router.get('/my-calendar',      auth,     ctrl.getMyCalendar);
router.post('/punch',           auth,     ctrl.punch);

// Admin / Manager
router.get('/today-overview',   adminMgr, ctrl.getTodayOverview);
router.get('/report',           adminMgr, ctrl.getReport);
router.get('/',                 auth,     ctrl.getAll);
router.post('/mark',            adminMgr, ctrl.mark);
router.put('/:id',              adminMgr, ctrl.update);
router.post('/:id/approve',     adminMgr, ctrl.approve);

module.exports = router;