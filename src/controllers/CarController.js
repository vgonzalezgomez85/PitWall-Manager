const Car = require('../models/Car');
const Category = require('../models/Category');
const BRANDS = require('../config/carBrands');

class CarController {

  static index(req, res) {
    const cars = Car.findAll();
    res.render('cars/index', { t: req.t, cars });
  }

  static new(req, res) {
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';
    res.render('cars/form', { t: req.t, lang, car: null, categories, brands: BRANDS, error: null });
  }

  static getOrCreateCategory(categoryName) {
    const trimmed = categoryName.trim();
    let category = Category.findByName(trimmed);
    if (!category) {
      Category.create(trimmed);
      category = Category.findByName(trimmed);
    }
    return category;
  }

  static create(req, res) {
    const { brand, model, category_name, description } = req.body;
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';

    if (!brand || !brand.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La marca es requerida' : 'Brand is required'
      });
    }

    if (!model || !model.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'El modelo es requerido' : 'Model is required'
      });
    }

    if (!category_name || !category_name.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La categoría es requerida' : 'Category is required'
      });
    }

    try {
      const category = CarController.getOrCreateCategory(category_name);
      Car.create(brand.trim(), model.trim(), category.id, description?.trim() || '');
      res.redirect('/cars');
    } catch (err) {
      res.render('cars/form', {
        t: req.t,
        lang,
        car: null,
        categories,
        brands: BRANDS,
        error: err.message || (lang === 'es' ? 'Error creando coche' : 'Error creating car')
      });
    }
  }

  static edit(req, res) {
    const car = Car.findById(parseInt(req.params.id, 10));
    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';
    res.render('cars/form', { t: req.t, lang, car, categories, brands: BRANDS, error: null });
  }

  static update(req, res) {
    const { brand, model, category_name, description } = req.body;
    const id = parseInt(req.params.id, 10);
    const car = Car.findById(id);
    const categories = Category.findAll();
    const lang = req.session?.lang || 'es';

    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    if (!brand || !brand.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La marca es requerida' : 'Brand is required'
      });
    }

    if (!model || !model.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'El modelo es requerido' : 'Model is required'
      });
    }

    if (!category_name || !category_name.trim()) {
      return res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: lang === 'es' ? 'La categoría es requerida' : 'Category is required'
      });
    }

    try {
      const category = CarController.getOrCreateCategory(category_name);
      Car.update(id, brand.trim(), model.trim(), category.id, description?.trim() || '');
      res.redirect('/cars');
    } catch (err) {
      res.render('cars/form', {
        t: req.t,
        lang,
        car,
        categories,
        brands: BRANDS,
        error: err.message || (lang === 'es' ? 'Error actualizando coche' : 'Error updating car')
      });
    }
  }

  static delete(req, res) {
    const id = parseInt(req.params.id, 10);
    const car = Car.findById(id);
    if (!car) return res.status(404).render('error', { t: req.t, code: 404, message: 'Car not found' });

    Car.delete(id);
    res.redirect('/cars');
  }
}

module.exports = CarController;
