const express = require('express');
const { body, validationResult } = require('express-validator');
const router  = express.Router();
const { authenticate, authorizeRoles } = require('../middleware/auth.middleware');
const ctrl = require('../controllers/offerLetter.controller');

const hr = [authenticate, authorizeRoles('Admin', 'HR')];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
};

// Reference data
router.get('/variables',              hr, ctrl.getVariables);
router.get('/stats',                  hr, ctrl.getStats);

// Templates
router.get('/templates',              hr, ctrl.getTemplates);
router.get('/templates/:id',          hr, ctrl.getTemplate);
router.post('/templates',             hr,
  [body('name').notEmpty(), body('letter_type').notEmpty(), body('body_html').notEmpty()],
  validate, ctrl.createTemplate
);
router.put('/templates/:id',          hr, ctrl.updateTemplate);

// Generated letters
router.get('/',                       hr, ctrl.getAll);
router.get('/:id',                    hr, ctrl.getOne);
router.get('/:id/download',           hr, ctrl.downloadPdf);
router.post('/generate',              hr,
  [body('template_id').notEmpty(), body('letter_type').optional()],
  validate, ctrl.generate
);
router.patch('/:id/status',           hr,
  [body('status').isIn(['Draft','Sent','Accepted','Declined','Expired'])],
  validate, ctrl.updateStatus
);

module.exports = router;