const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/onboarding.controller');

const hr   = [authenticate, authorizeRoles('Admin','HR','Manager')];
const auth = [authenticate];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Stats
router.get('/stats',                hr,   ctrl.getStats);

// Employee self-view
router.get('/my-plan',              auth, ctrl.getMyPlan);

// Plans
router.get('/plans',                hr,   ctrl.getPlans);
router.get('/plans/:id',            auth, ctrl.getPlan);
router.post('/plans',               hr,
  [body('employee_id').notEmpty(), body('joining_date').isDate(), body('target_date').isDate(), body('title').notEmpty()],
  validate, ctrl.createPlan
);
router.put('/plans/:id',            hr,   ctrl.updatePlan);
router.post('/plans/:id/tasks',     hr,
  [body('title').notEmpty()],
  validate, ctrl.addTask
);
router.post('/plans/:id/comments',  auth, ctrl.addComment);

// Tasks
router.patch('/tasks/:taskId/complete', auth, ctrl.completeTask);
router.patch('/tasks/:taskId/skip',     hr,   ctrl.skipTask);

// Templates
router.get('/templates',            auth, ctrl.getTemplates);
router.get('/templates/:id',        auth, ctrl.getTemplate);
router.post('/templates',           hr,
  [body('name').notEmpty()],
  validate, ctrl.createTemplate
);

module.exports = router;