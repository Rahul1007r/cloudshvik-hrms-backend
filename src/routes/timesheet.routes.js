const express = require('express');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/timesheet.controller');

const auth     = [authenticate];
const adminMgr = [authenticate, authorizeRoles('Admin', 'HR', 'Manager')];

// Employee self-service
router.get('/current',      auth,     ctrl.getCurrent);
router.get('/week',         auth,     ctrl.getByWeek);
router.get('/stats',        adminMgr, ctrl.getStats);
router.get('/',             auth,     ctrl.getAll);
router.get('/:id',          auth,     ctrl.getById);

// Save entries (draft)
router.put('/:id/entries',  auth,     ctrl.saveEntries);

// Workflow
router.post('/:id/submit',  auth,     ctrl.submit);
router.post('/:id/approve', adminMgr, ctrl.approve);
router.post('/:id/reject',  adminMgr, ctrl.reject);

module.exports = router;