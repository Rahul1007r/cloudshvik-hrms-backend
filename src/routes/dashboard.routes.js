const express = require('express');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../../src/middleware/auth.middleware');

const {
  getStats,
  getAttendanceChart,
  getDeptDistribution,
  getRecentActivity,
  getPendingLeaves,
  getMonthlyHeadcount,
} = require('../../src/controllers/dashboard.controller');

// All dashboard routes require authentication
// Admin / HR / Manager can view dashboard
const guard = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

router.get('/stats',              guard, getStats);
router.get('/attendance-chart',   guard, getAttendanceChart);
router.get('/dept-distribution',  guard, getDeptDistribution);
router.get('/recent-activity',    guard, getRecentActivity);
router.get('/pending-leaves',     guard, getPendingLeaves);
router.get('/monthly-headcount',  guard, getMonthlyHeadcount);

module.exports = router;