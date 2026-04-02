const express = require('express');
const router  = express.Router();
const { authenticate } = require('../../src/middleware/auth.middleware');

const {
  getProfile,
  getAttendanceSummary,
  getLeaveBalance,
  getPayslips,
  getAnnouncements,
  getUpcomingHolidays,
  punch,
} = require('../../src/controllers/employeeDashboard.controller');

// All routes require authentication (any role)
router.use(authenticate);

router.get('/profile',             getProfile);
router.get('/attendance-summary',  getAttendanceSummary);
router.get('/leave-balance',       getLeaveBalance);
router.get('/payslips',            getPayslips);
router.get('/announcements',       getAnnouncements);
router.get('/upcoming-holidays',   getUpcomingHolidays);
router.post('/punch',              punch);

module.exports = router;