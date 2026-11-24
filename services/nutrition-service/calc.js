'use strict';
const { round1 } = require('../shared/util');

const ACTIVITY_FACTOR = { low: 1.2, moderate: 1.375, high: 1.55, very_high: 1.725 };
const GOAL_FACTOR = { weight_loss: 0.85, maintenance: 1, weight_gain: 1.15 };

/** BMR по формуле Mifflin-St Jeor. */
function bmr({ gender, weight, height, age }) {
  return 10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : -161);
}

/** Персональные нормы: калории = BMR × коэффициент активности × коэффициент цели; белок 1.6 г/кг; жиры 25% калорий. */
function calcNorms(profile) {
  const tdee = bmr(profile) * ACTIVITY_FACTOR[profile.activityLevel];
  const dailyCalories = Math.round(tdee * GOAL_FACTOR[profile.goal]);
  const protein = Math.round(profile.weight * 1.6);
  const fat = Math.round((dailyCalories * 0.25) / 9);
  const carbohydrates = Math.max(0, Math.round((dailyCalories - protein * 4 - fat * 9) / 4));
  return { userId: profile.userId, dailyCalories, protein, fat, carbohydrates, calculationMethod: 'Mifflin-St Jeor' };
}

function emptySummary(userId, date, goal = null) {
  return {
    userId, date, consumedCalories: 0, consumedProtein: 0, consumedFat: 0, consumedCarbohydrates: 0,
    dailyCaloriesGoal: goal, remainingCalories: goal, updatedAt: new Date().toISOString(),
  };
}

/** Добавляет (sign=1) или вычитает (sign=-1) КБЖУ записи из дневной сводки. */
function applyMacros(summary, m, sign = 1) {
  const add = (cur, v) => Math.max(0, round1(cur + sign * (v || 0)));
  summary.consumedCalories = add(summary.consumedCalories, m.calories);
  summary.consumedProtein = add(summary.consumedProtein, m.protein);
  summary.consumedFat = add(summary.consumedFat, m.fat);
  summary.consumedCarbohydrates = add(summary.consumedCarbohydrates, m.carbohydrates);
  return finalize(summary);
}

function finalize(summary) {
  summary.remainingCalories = summary.dailyCaloriesGoal == null
    ? null : round1(summary.dailyCaloriesGoal - summary.consumedCalories);
  summary.updatedAt = new Date().toISOString();
  return summary;
}

module.exports = { calcNorms, bmr, emptySummary, applyMacros, finalize };
