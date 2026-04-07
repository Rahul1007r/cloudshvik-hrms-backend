const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/settings.controller');

const adminOnly = [authenticate, authorizeRoles('Admin')];
const authAll   = [authenticate]; // some settings are readable by all

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Settings CRUD
router.get('/',              authAll,   ctrl.getAll);
router.get('/:group',        authAll,   ctrl.getGroup);
router.put('/',              adminOnly, ctrl.updateAll);

// Holidays
router.get('/holidays/list',  authAll,   ctrl.getHolidays);
router.post('/holidays',      adminOnly,
  [body('name').notEmpty().trim(), body('date').isDate()],
  validate, ctrl.createHoliday
);
router.put('/holidays/:id',   adminOnly, ctrl.updateHoliday);
router.delete('/holidays/:id',adminOnly, ctrl.deleteHoliday);
router.post('/holidays/bulk', adminOnly, ctrl.bulkCreateHolidays);

module.exports = router;