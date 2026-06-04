import { Env } from "../types";
import { queryOne, queryAll, execute } from "./client";

export interface UserAnalytics {
  id: number;
  date: string;
  period_type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  active_users: number;
  new_users: number;
  total_words_learned: number;
  total_sessions: number;
  avg_session_duration: number;
  created_at: string;
}

export interface AnalyticsSummary {
  daily: UserAnalytics | null;
  weekly: UserAnalytics | null;
  monthly: UserAnalytics | null;
  yearly: UserAnalytics | null;
}

// Calculate daily analytics
export async function calculateDailyAnalytics(env: Env, date: string): Promise<void> {
  const startOfDay = date + ' 00:00:00';
  const endOfDay = date + ' 23:59:59';

  // Count active users (users who did any activity today)
  const activeUsersResult = await queryOne<{ count: number }>(
    env,
    `SELECT COUNT(DISTINCT u.id) as count
     FROM users u
     WHERE u.is_approved = 1 
     AND u.is_banned = 0
     AND EXISTS (
       SELECT 1 FROM activity_log al 
       WHERE al.user_id = u.id 
       AND al.created_at >= ? AND al.created_at <= ?
     )`,
    [startOfDay, endOfDay]
  );

  // Count new users who registered today
  const newUsersResult = await queryOne<{ count: number }>(
    env,
    `SELECT COUNT(*) as count
     FROM users 
     WHERE is_approved = 1 
     AND created_at >= ? AND created_at <= ?`,
    [startOfDay, endOfDay]
  );

  // Count total words learned today (from activity_log with word learning activities)
  const wordsLearnedResult = await queryOne<{ count: number }>(
    env,
    `SELECT COUNT(*) as count
     FROM activity_log al
     JOIN users u ON al.user_id = u.id
     WHERE al.activity_type IN ('leitner_correct', 'reading_completed')
     AND al.created_at >= ? AND al.created_at <= ?
     AND u.is_approved = 1 AND u.is_banned = 0`,
    [startOfDay, endOfDay]
  );

  // Count total sessions (reading sessions + leitner sessions)
  const sessionsResult = await queryOne<{ count: number }>(
    env,
    `SELECT 
       COUNT(DISTINCT al.user_id) as count
     FROM activity_log al
     JOIN users u ON al.user_id = u.id
     WHERE al.created_at >= ? AND al.created_at <= ?
     AND u.is_approved = 1 AND u.is_banned = 0`,
    [startOfDay, endOfDay]
  );

  // Calculate average session duration (this is simplified - in real implementation you'd track session start/end)
  const avgSessionDuration = 15; // Default 15 minutes as placeholder

  const analytics = {
    date,
    period_type: 'daily' as const,
    active_users: activeUsersResult?.count || 0,
    new_users: newUsersResult?.count || 0,
    total_words_learned: wordsLearnedResult?.count || 0,
    total_sessions: sessionsResult?.count || 0,
    avg_session_duration: avgSessionDuration
  };

  // Insert or update daily analytics
  await execute(
    env,
    `INSERT OR REPLACE INTO user_analytics 
     (date, period_type, active_users, new_users, total_words_learned, total_sessions, avg_session_duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [analytics.date, analytics.period_type, analytics.active_users, analytics.new_users, 
     analytics.total_words_learned, analytics.total_sessions, analytics.avg_session_duration]
  );

  console.log(`Daily analytics calculated for ${date}: ${analytics.active_users} active users`);
}

// Calculate weekly analytics (sum of last 7 days)
export async function calculateWeeklyAnalytics(env: Env, weekStartDate: string): Promise<void> {
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEndDateStr = weekEndDate.toISOString().split('T')[0];

  const dailyAnalytics = await queryAll<UserAnalytics>(
    env,
    `SELECT * FROM user_analytics 
     WHERE date >= ? AND date <= ? AND period_type = 'daily'
     ORDER BY date`,
    [weekStartDate, weekEndDateStr]
  );

  if (dailyAnalytics.length === 0) return;

  const weeklyStats = dailyAnalytics.reduce((acc, day) => ({
    active_users: Math.max(acc.active_users, day.active_users), // Peak active users
    new_users: acc.new_users + day.new_users,
    total_words_learned: acc.total_words_learned + day.total_words_learned,
    total_sessions: acc.total_sessions + day.total_sessions,
    avg_session_duration: (acc.avg_session_duration + day.avg_session_duration) / 2
  }), {
    active_users: 0,
    new_users: 0,
    total_words_learned: 0,
    total_sessions: 0,
    avg_session_duration: 0
  });

  await execute(
    env,
    `INSERT OR REPLACE INTO user_analytics 
     (date, period_type, active_users, new_users, total_words_learned, total_sessions, avg_session_duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [weekStartDate, 'weekly', weeklyStats.active_users, weeklyStats.new_users,
     weeklyStats.total_words_learned, weeklyStats.total_sessions, weeklyStats.avg_session_duration]
  );
}

// Calculate monthly analytics
export async function calculateMonthlyAnalytics(env: Env, yearMonth: string): Promise<void> {
  const startDate = yearMonth + '-01';
  const endDate = new Date(yearMonth + '-01');
  endDate.setMonth(endDate.getMonth() + 1);
  endDate.setDate(0);
  const endDateStr = endDate.toISOString().split('T')[0];

  const dailyAnalytics = await queryAll<UserAnalytics>(
    env,
    `SELECT * FROM user_analytics 
     WHERE date >= ? AND date <= ? AND period_type = 'daily'
     ORDER BY date`,
    [startDate, endDateStr]
  );

  if (dailyAnalytics.length === 0) return;

  const monthlyStats = dailyAnalytics.reduce((acc, day) => ({
    active_users: Math.max(acc.active_users, day.active_users),
    new_users: acc.new_users + day.new_users,
    total_words_learned: acc.total_words_learned + day.total_words_learned,
    total_sessions: acc.total_sessions + day.total_sessions,
    avg_session_duration: (acc.avg_session_duration + day.avg_session_duration) / 2
  }), {
    active_users: 0,
    new_users: 0,
    total_words_learned: 0,
    total_sessions: 0,
    avg_session_duration: 0
  });

  await execute(
    env,
    `INSERT OR REPLACE INTO user_analytics 
     (date, period_type, active_users, new_users, total_words_learned, total_sessions, avg_session_duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [yearMonth, 'monthly', monthlyStats.active_users, monthlyStats.new_users,
     monthlyStats.total_words_learned, monthlyStats.total_sessions, monthlyStats.avg_session_duration]
  );
}

// Get analytics summary for dashboard
export async function getAnalyticsSummary(env: Env): Promise<AnalyticsSummary> {
  const today = new Date().toISOString().split('T')[0];
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const currentMonth = today.substring(0, 7); // YYYY-MM
  const currentYear = today.substring(0, 4); // YYYY

  const [daily, weekly, monthly, yearly] = await Promise.all([
    queryOne<UserAnalytics>(
      env,
      "SELECT * FROM user_analytics WHERE date = ? AND period_type = 'daily'",
      [today]
    ),
    queryOne<UserAnalytics>(
      env,
      "SELECT * FROM user_analytics WHERE date = ? AND period_type = 'weekly'",
      [weekStartStr]
    ),
    queryOne<UserAnalytics>(
      env,
      "SELECT * FROM user_analytics WHERE date = ? AND period_type = 'monthly'",
      [currentMonth]
    ),
    queryOne<UserAnalytics>(
      env,
      "SELECT * FROM user_analytics WHERE date = ? AND period_type = 'yearly'",
      [currentYear]
    )
  ]);

  return {
    daily: daily || null,
    weekly: weekly || null,
    monthly: monthly || null,
    yearly: yearly || null
  };
}

// Get analytics history for charts
export async function getAnalyticsHistory(env: Env, periodType: 'daily' | 'weekly' | 'monthly', limit: number = 30): Promise<UserAnalytics[]> {
  return await queryAll<UserAnalytics>(
    env,
    `SELECT * FROM user_analytics 
     WHERE period_type = ? 
     ORDER BY date DESC 
     LIMIT ?`,
    [periodType, limit]
  );
}

// Get current user counts
export async function getCurrentUserStats(env: Env): Promise<{
  total_users: number;
  approved_users: number;
  banned_users: number;
  active_today: number;
}> {
  const [total, approved, banned, activeToday] = await Promise.all([
    queryOne<{ count: number }>(env, "SELECT COUNT(*) as count FROM users"),
    queryOne<{ count: number }>(env, "SELECT COUNT(*) as count FROM users WHERE is_approved = 1"),
    queryOne<{ count: number }>(env, "SELECT COUNT(*) as count FROM users WHERE is_banned = 1"),
    queryOne<{ count: number }>(
      env,
      `SELECT COUNT(DISTINCT u.id) as count
       FROM users u
       WHERE u.is_approved = 1 
       AND u.is_banned = 0
       AND EXISTS (
         SELECT 1 FROM activity_log al 
         WHERE al.user_id = u.id 
         AND al.created_at >= datetime('now', 'start of day')
       )`
    )
  ]);

  return {
    total_users: total?.count || 0,
    approved_users: approved?.count || 0,
    banned_users: banned?.count || 0,
    active_today: activeToday?.count || 0
  };
}

// Run all analytics calculations (called by cron job)
export async function runAllAnalyticsCalculations(env: Env): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  
  console.log("Starting analytics calculations for", today);
  
  try {
    // Calculate today's analytics
    await calculateDailyAnalytics(env, today);
    
    // Calculate weekly analytics if today is Sunday
    const todayObj = new Date(today);
    if (todayObj.getDay() === 0) { // Sunday
      const weekStart = new Date(todayObj);
      weekStart.setDate(todayObj.getDate() - todayObj.getDay());
      await calculateWeeklyAnalytics(env, weekStart.toISOString().split('T')[0]);
    }
    
    // Calculate monthly analytics if today is the first day of the month
    if (todayObj.getDate() === 1) {
      const yearMonth = today.substring(0, 7);
      await calculateMonthlyAnalytics(env, yearMonth);
    }
    
    // Clean up old analytics data (keep last 2 years)
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const cutoffDate = twoYearsAgo.toISOString().split('T')[0];
    
    await execute(
      env,
      "DELETE FROM user_analytics WHERE date < ?",
      [cutoffDate]
    );
    
    console.log("Analytics calculations completed successfully");
  } catch (error) {
    console.error("Error in analytics calculations:", error);
    throw error;
  }
}
