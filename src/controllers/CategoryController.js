const Category = require('../models/Category');

class CategoryController {

  static index(req, res) {
    const categories = Category.findAll();
    res.render('categories/index', { t: req.t, categories });
  }

  static new(req, res) {
    const lang = req.session?.lang || 'es';
    res.render('categories/form', { t: req.t, lang, category: null, error: null });
  }

  static create(req, res) {
    const { name, description } = req.body;
    const lang = req.session?.lang || 'es';

    if (!name || !name.trim()) {
      return res.render('categories/form', {
        t: req.t,
        lang,
        category: null,
        error: lang === 'es' ? 'El nombre es requerido' : 'Category name is required'
      });
    }

    try {
      Category.create(name.trim(), description?.trim() || '');
      res.redirect('/categories');
    } catch (err) {
      res.render('categories/form', {
        t: req.t,
        lang,
        category: null,
        error: err.message || (lang === 'es' ? 'Error creando categoría' : 'Error creating category')
      });
    }
  }

  static edit(req, res) {
    const category = Category.findById(parseInt(req.params.id, 10));
    if (!category) return res.status(404).render('error', { t: req.t, code: 404, message: 'Category not found' });
    const lang = req.session?.lang || 'es';
    res.render('categories/form', { t: req.t, lang, category, error: null });
  }

  static update(req, res) {
    const { name, description } = req.body;
    const id = parseInt(req.params.id, 10);
    const category = Category.findById(id);
    const lang = req.session?.lang || 'es';

    if (!category) return res.status(404).render('error', { t: req.t, code: 404, message: 'Category not found' });
    if (!name || !name.trim()) {
      return res.render('categories/form', {
        t: req.t,
        lang,
        category,
        error: lang === 'es' ? 'El nombre es requerido' : 'Category name is required'
      });
    }

    try {
      Category.update(id, name.trim(), description?.trim() || '');
      res.redirect('/categories');
    } catch (err) {
      res.render('categories/form', {
        t: req.t,
        lang,
        category,
        error: err.message || (lang === 'es' ? 'Error actualizando categoría' : 'Error updating category')
      });
    }
  }

  static delete(req, res) {
    const id = parseInt(req.params.id, 10);
    const category = Category.findById(id);
    if (!category) return res.status(404).render('error', { t: req.t, code: 404, message: 'Category not found' });

    Category.delete(id);
    res.redirect('/categories');
  }

  static apiCreate(req, res) {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    try {
      const result = Category.create(name.trim(), description?.trim() || '');
      const newCategory = Category.findById(result.lastInsertRowid);
      res.json({ success: true, id: newCategory.id, name: newCategory.name });
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Category already exists' });
      }
      res.status(500).json({ error: err.message || 'Error creating category' });
    }
  }
}

module.exports = CategoryController;
