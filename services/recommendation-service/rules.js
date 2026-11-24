'use strict';

/**
 * Правила формирования рекомендаций по дневной сводке питания.
 * summary: { consumedCalories, consumedProtein }, goal: суточная цель по калориям (или null).
 */
function evaluate({ summary, goal }) {
  const out = [];
  const cal = summary.consumedCalories || 0;
  const proteinShare = cal > 0 ? ((summary.consumedProtein || 0) * 4) / cal : 0;

  if (goal != null && cal > goal) {
    out.push({
      key: 'calorie_excess', type: 'nutrition', title: 'Превышена дневная норма калорий',
      description: 'Постарайтесь сделать следующий приём пищи легче и добавьте прогулку.',
      reason: `Потреблено ${cal} ккал при цели ${goal} ккал`,
    });
  }
  if (cal >= 300 && proteinShare < 0.15) {
    out.push({
      key: 'low_protein', type: 'nutrition', title: 'Увеличьте потребление белка',
      description: 'Добавьте в рацион творог, яйца, рыбу или куриную грудку.',
      reason: `Доля белка в калорийности — ${Math.round(proteinShare * 100)}% (рекомендуется от 15%)`,
    });
  }
  if (goal != null && cal >= goal * 0.5 && cal <= goal && proteinShare >= 0.15) {
    out.push({
      key: 'on_track', type: 'general', title: 'Вы укладываетесь в норму',
      description: 'Отличный баланс — продолжайте в том же духе.',
      reason: `Потреблено ${cal} из ${goal} ккал, белка достаточно`,
    });
  }
  return out;
}

function activityTip(profile) {
  const tips = {
    weight_loss: ['Добавьте 30 минут ходьбы', 'Для цели «похудение» полезны ежедневные прогулки и кардио.'],
    maintenance: ['Поддерживайте активность', 'Для поддержания веса достаточно 150 минут умеренной активности в неделю.'],
    weight_gain: ['Добавьте силовые тренировки', 'Для набора массы полезны силовые тренировки 3 раза в неделю.'],
  };
  const [title, description] = tips[profile.goal] || tips.maintenance;
  return { key: 'activity_goal', type: 'activity', title, description, reason: `Цель пользователя: ${profile.goal}` };
}

module.exports = { evaluate, activityTip };
