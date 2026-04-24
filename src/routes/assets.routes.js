const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/assets.controller');

const hr   = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, errors: errs.array() });
  next();
};

// Reference & self-view
router.get('/categories',              auth, ctrl.getCategories);
router.get('/stats',                   hr,   ctrl.getStats);
router.get('/my-assets',               auth, ctrl.getMyAssets);

// Employee assets (HR view)
router.get('/employee/:empId',         hr,   ctrl.getEmployeeAssets);

// Asset CRUD
router.get('/',                        auth, ctrl.getAll);
router.get('/:id',                     auth, ctrl.getOne);
router.post('/',
  hr,
  [body('name').notEmpty().trim(), body('category_id').notEmpty()],
  validate, ctrl.create
);
router.put('/:id',                     hr,   ctrl.update);

// Workflow
router.post('/:id/assign',
  hr,
  [body('employee_id').notEmpty()],
  validate, ctrl.assign
);
router.post('/:id/return',             hr,   ctrl.returnAsset);
router.post('/:id/maintenance',
  hr,
  [body('description').notEmpty(), body('start_date').isDate()],
  validate, ctrl.addMaintenance
);
router.patch('/maintenance/:mainId/complete', hr, ctrl.completeMaintenance);

module.exports = router;