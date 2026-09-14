package expo.modules.ledgrnativeai

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Production ownership operations shared by the Expo bridge and desktop regressions.
 * All teardown and hashing run on the SAME executor as inference. A queued timeout
 * never means JNI stopped. Poison is deliberately process-lifetime.
 */
class GemmaLifecycle(
  private val executor: Executor,
  private val admitted: AtomicReference<String?>,
  private val shutdown: AtomicBoolean,
  private val poisoned: AtomicBoolean,
  private val store: () -> GemmaPackStore,
  private val finish: (String) -> Unit,
  private val unload: () -> Unit,
  private val activeId: () -> String?,
  private val loadedModel: () -> String?,
  private val release: (String) -> Unit,
) {
  private fun healthy() {
    if (shutdown.get()) throw GemmaPackException("GEMMA_SHUTDOWN")
    if (poisoned.get()) throw GemmaPackException("NATIVE_RECOVERY_REQUIRED")
  }

  /** Scheduling-time admission, also used by the Expo begin entry point. */
  fun admitRequest(id: String) {
    if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) throw GemmaPackException("INVALID_REQUEST_ID")
    healthy()
    if (!admitted.compareAndSet(null, id)) throw GemmaPackException("GEMMA_BUSY")
  }

  /** Exclusive management work shares the inference queue, including downloads. */
  fun management(token: String, action: () -> String, complete: (Result<String>) -> Unit) {
    try {
      healthy()
      require(token.contains(':')) { "INVALID_MANAGEMENT_TOKEN" }
      if (!admitted.compareAndSet(null, token)) throw GemmaPackException("MODEL_IN_USE")
    } catch (error: Exception) {
      complete(Result.failure(error)); return
    }
    try {
      executor.execute {
        val outcome = runCatching {
          healthy()
          if (admitted.get() != token) throw GemmaPackException("STALE_SESSION")
          action()
        }
        val error = outcome.exceptionOrNull()
        if (error != null && (error !is Exception || error.message == "NATIVE_RECOVERY_REQUIRED")) {
          poisoned.set(true)
        }
        admitted.compareAndSet(token, null)
        complete(if (poisoned.get()) Result.failure(GemmaPackException("NATIVE_RECOVERY_REQUIRED")) else outcome)
      }
    } catch (_: RejectedExecutionException) {
      admitted.compareAndSet(token, null)
      complete(Result.failure(GemmaPackException("GEMMA_SHUTDOWN")))
    }
  }

  /** Queue used by begin/resume AND attachment operations in the shipped bridge. */
  fun work(id: String?, action: () -> String, complete: (Result<String>) -> Unit) {
    try { healthy() } catch (error: Exception) {
      if (shutdown.get()) id?.let { admitted.compareAndSet(it, null) }
      complete(Result.failure(error)); return
    }
    try {
      executor.execute {
        val outcome = runCatching {
          healthy()
          if (id != null && admitted.get() != id) throw GemmaPackException("STALE_SESSION")
          action()
        }
        val error = outcome.exceptionOrNull()
        if (error == null) {
          complete(outcome)
        } else {
          if (error.message == "NATIVE_RECOVERY_REQUIRED") poisoned.set(true)
          if (error is OutOfMemoryError && id != null && admitted.get() == id) {
            try { unload(); release(id) } catch (_: Throwable) { poisoned.set(true) }
          } else if (error !is Exception) {
            poisoned.set(true)
          } else {
            failedRequest(id)
          }
          val failure = when {
            poisoned.get() -> GemmaPackException("NATIVE_RECOVERY_REQUIRED")
            error is OutOfMemoryError -> GemmaPackException("GEMMA_MEMORY")
            else -> error
          }
          complete(Result.failure(failure))
        }
      }
    } catch (_: RejectedExecutionException) {
      // No task was enqueued; do not free any native/media object on this thread.
      id?.let { admitted.compareAndSet(it, null) }
      complete(Result.failure(GemmaPackException("GEMMA_SHUTDOWN")))
    }
  }

  /** Called on the owner executor after begin/resume failed, never for another ID. */
  fun failedRequest(id: String?) {
    if (id == null || poisoned.get() || admitted.get() != id) return
    try {
      finish(id)
      release(id)
    } catch (_: Throwable) {
      poisoned.set(true)
    }
  }

  /**
   * Finish is idempotent even for a rejected request. Recovery is exclusive:
   * a delayed recovery must not unload the engine of a newer admitted request.
   * Reserve idle ownership BEFORE queueing so a retired ID can recover safely.
   */
  fun terminal(id: String, recover: Boolean, complete: (Result<String>) -> Unit) {
    if (!id.matches(Regex("[A-Za-z0-9_-]{1,80}"))) {
      complete(Result.failure(GemmaPackException("INVALID_REQUEST_ID")))
      return
    }
    try { healthy() } catch (error: Exception) {
      complete(Result.failure(error)); return
    }
    val token = "terminal:$id"
    val reserved = admitted.compareAndSet(null, token)
    if (recover && !reserved && admitted.get() != id) {
      complete(Result.failure(GemmaPackException("STALE_SESSION"))); return
    }
    try {
      executor.execute {
        val outcome = runCatching {
          healthy()
          val owner = admitted.get()
          val active = activeId()
          val different = (owner != null && owner != id && !(reserved && owner == token)) ||
            (active != null && active != id)
          if (recover && different) throw GemmaPackException("STALE_SESSION")
          // A stale finish may release only its own attachments, never B's JNI.
          try {
            if (!different) {
              finish(id)
              if (recover) unload()
            }
            release(id)
          } catch (_: Throwable) {
            poisoned.set(true)
            throw GemmaPackException("NATIVE_RECOVERY_REQUIRED")
          }
          "{\"requestId\":\"$id\",\"finished\":true}"
        }
        if (reserved) admitted.compareAndSet(token, null)
        complete(outcome)
      }
    } catch (_: RejectedExecutionException) {
      if (reserved) admitted.compareAndSet(token, null)
      complete(Result.failure(GemmaPackException("GEMMA_SHUTDOWN")))
    }
  }

  /** Owner executor only, inside the exclusive remove reservation. */
  fun removeModel(id: String): String {
    healthy()
    if (admitted.get() != "remove:$id" || activeId() != null) throw GemmaPackException("MODEL_IN_USE")
    if (loadedModel() == id) {
      try { unload() } catch (_: Throwable) {
        poisoned.set(true)
        throw GemmaPackException("NATIVE_RECOVERY_REQUIRED")
      }
    }
    return "{\"removed\":${store().remove(id)}}"
  }

  /** Coalesces concurrent polling and drains all installed packs, with no HTTP. */
  fun scheduleInstalledVerification() {
    if (shutdown.get() || poisoned.get()) return
    val packs = store()
    val id = packs.approvedIds().firstOrNull { packs.state(it) == GemmaPackState.VERIFYING } ?: return
    val token = "verify:$id"
    if (!admitted.compareAndSet(null, token)) return
    try {
      executor.execute {
        try {
          if (!shutdown.get() && !poisoned.get() && admitted.get() == token) {
            packs.verifiedFile(id) { shutdown.get() || Thread.currentThread().isInterrupted }
          }
        } catch (_: Throwable) {
          // Includes interrupted hashing and OOM; ERROR is not retried by polling.
          packs.recordVerificationFailure(id)
        } finally {
          admitted.compareAndSet(token, null)
        }
        if (!shutdown.get() && !poisoned.get()) scheduleInstalledVerification()
      }
    } catch (_: RejectedExecutionException) {
      admitted.compareAndSet(token, null)
    }
  }
}
