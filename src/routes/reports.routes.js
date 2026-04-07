const express = require('express');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/reports.controller');

const admin = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

router.get('/overview',         admin, ctrl.overview);
router.get('/attendance',       admin, ctrl.attendanceReport);
router.get('/leave',            admin, ctrl.leaveReport);
router.get('/payroll',          admin, ctrl.payrollReport);
router.get('/employees',        admin, ctrl.employeeReport);
router.get('/headcount-trend',  admin, ctrl.headcountTrend);
router.get('/audit-log',        [authenticate, authorizeRoles('Admin')], ctrl.auditLog);

module.exports = router;