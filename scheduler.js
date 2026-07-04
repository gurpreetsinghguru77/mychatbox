import schedule from 'node-schedule';

let whatsappClient = null;

export const setWhatsAppClient = (client) => {
  whatsappClient = client;
};

// Store jobs in memory to list or cancel them later
export const scheduledJobs = new Map();

/**
 * Schedules a message to be sent to a specific contact at a specific time.
 * @param {string} contactId - The WhatsApp contact ID (e.g., 919876543210@c.us)
 * @param {string} message - The text message to send
 * @param {Date} date - The Javascript Date object when it should be sent
 * @returns {string} jobId - The unique ID of the scheduled job
 */
export const scheduleMessage = (contactId, message, date) => {
  const jobId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  
  const job = schedule.scheduleJob(date, async () => {
    try {
      if (whatsappClient) {
        await whatsappClient.sendMessage(contactId, message);
        console.log(`[SCHEDULER] Successfully sent scheduled message to ${contactId}`);
      } else {
        console.error(`[SCHEDULER] Failed to send scheduled message to ${contactId}: WhatsApp client is not initialized.`);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Error sending scheduled message:`, err);
    } finally {
      // Remove from map after execution
      scheduledJobs.delete(jobId);
    }
  });

  if (job) {
    scheduledJobs.set(jobId, { contactId, message, date, job });
    console.log(`[SCHEDULER] Scheduled message for ${contactId} at ${date.toLocaleString()}`);
    return jobId;
  }
  
  return null;
};

export const cancelJob = (jobId) => {
  const jobEntry = scheduledJobs.get(jobId);
  if (jobEntry && jobEntry.job) {
    jobEntry.job.cancel();
    scheduledJobs.delete(jobId);
    console.log(`[SCHEDULER] Cancelled job ${jobId}`);
    return true;
  }
  return false;
};
