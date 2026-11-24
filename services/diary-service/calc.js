'use strict';
const { round1 } = require('../shared/util');

/** КБЖУ на порцию: значения продукта заданы на 100 г/мл (для ml плотность принимается равной 1). */
function calcMacros(per100, quantity) {
  const f = quantity / 100;
  return {
    calories: round1(per100.calories * f),
    protein: round1((per100.protein || 0) * f),
    fat: round1((per100.fat || 0) * f),
    carbohydrates: round1((per100.carbohydrates || 0) * f),
  };
}
module.exports = { calcMacros };
