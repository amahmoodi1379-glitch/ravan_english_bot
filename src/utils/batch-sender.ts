import { Env } from "../types";
import { sendMessage } from "../bot/telegram-api";
import { 
  updateAnnouncementStatus, 
  updateAnnouncementCounts, 
  logAnnouncementDelivery,
  getApprovedUsers 
} from "../db/admin";

interface BatchSendConfig {
  batchSize: number;
  delayBetweenBatches: number; // in milliseconds
  maxRetries: number;
}

const DEFAULT_CONFIG: BatchSendConfig = {
  batchSize: 100,
  delayBetweenBatches: 1000, // 1 second
  maxRetries: 3
};

export async function sendAnnouncementBatch(
  env: Env, 
  announcementId: number,
  message: string,
  config: Partial<BatchSendConfig> = {}
): Promise<void> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  try {
    // Update status to sending
    await updateAnnouncementStatus(env, announcementId, 'sending');
    
    // Get all approved users
    const users = await getApprovedUsers(env);
    const totalUsers = users.length;
    
    let sentCount = 0;
    let failedCount = 0;
    
    console.log(`Starting batch announcement send to ${totalUsers} users`);
    
    // Process users in batches
    for (let i = 0; i < users.length; i += finalConfig.batchSize) {
      const batch = users.slice(i, i + finalConfig.batchSize);
      
      console.log(`Processing batch ${Math.floor(i / finalConfig.batchSize) + 1}/${Math.ceil(users.length / finalConfig.batchSize)}`);
      
      // Send messages in parallel within the batch
      const batchPromises = batch.map(async (user) => {
        try {
          await sendMessage(env, user.telegram_id, message);
          await logAnnouncementDelivery(env, announcementId, user.id, 'sent');
          return { success: true, userId: user.id };
        } catch (error) {
          console.error(`Failed to send to user ${user.telegram_id}:`, error);
          await logAnnouncementDelivery(env, announcementId, user.id, 'failed', error instanceof Error ? error.message : 'Unknown error');
          return { success: false, userId: user.id, error };
        }
      });
      
      // Wait for all messages in this batch to complete
      const results = await Promise.allSettled(batchPromises);
      
      // Count successes and failures
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            sentCount++;
          } else {
            failedCount++;
          }
        } else {
          failedCount++;
        }
      });
      
      // Update counts after each batch
      await updateAnnouncementCounts(env, announcementId, sentCount, failedCount);
      
      // Delay between batches to respect rate limits
      if (i + finalConfig.batchSize < users.length) {
        console.log(`Delaying ${finalConfig.delayBetweenBatches}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, finalConfig.delayBetweenBatches));
      }
    }
    
    // Update final status
    await updateAnnouncementStatus(env, announcementId, 'completed');
    
    console.log(`Announcement send completed: ${sentCount} sent, ${failedCount} failed out of ${totalUsers} total`);
    
  } catch (error) {
    console.error('Error in batch announcement send:', error);
    await updateAnnouncementStatus(env, announcementId, 'failed');
    throw error;
  }
}

// Function to start batch sending in background (for use in cron jobs or scheduled tasks)
export function scheduleAnnouncementSend(
  env: Env, 
  announcementId: number, 
  message: string
): void {
  // Use setTimeout to run asynchronously without blocking
  setTimeout(async () => {
    try {
      await sendAnnouncementBatch(env, announcementId, message);
    } catch (error) {
      console.error('Scheduled announcement send failed:', error);
    }
  }, 100);
}

// Utility function to estimate sending time
export function estimateSendingTime(userCount: number, config: Partial<BatchSendConfig> = {}): number {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const batches = Math.ceil(userCount / finalConfig.batchSize);
  const totalDelayTime = (batches - 1) * finalConfig.delayBetweenBatches;
  const estimatedSendTime = batches * 5000; // Estimate 5 seconds per batch for actual sending
  
  return totalDelayTime + estimatedSendTime;
}
