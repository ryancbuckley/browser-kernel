// Ways a process with threads ends, by argv[1]:
//   thread-exit   a thread calls exit(5) while the main thread waits to join it
//   thread-trap   a thread traps while the main thread waits to join it
//   negative      a thread calls exit(-1), which is 255
//   race          8 threads call exit(10 + i) at once
//   futex         the main thread exits(3) while a thread waits on a condition variable (in wasm,
//                 not a system call)
//   stdin         the main thread exits(4) while a thread waits to read stdin
//   sleep         the main thread exits(6) while a thread sleeps for a minute
//   return        main returns 0 while a thread spins
//   spin          every thread spins, until the test kills the process
//   spare         a thread returns and is joined (its worker is kept for the next thread), then
//                 the main thread exits(7)
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cond = PTHREAD_COND_INITIALIZER;
static pthread_barrier_t barrier;
static volatile int spinning = 1;

static void *exit_5(void *arg) { exit(5); }
static void *exit_minus_1(void *arg) { exit(-1); }
static void *trap(void *arg) { __builtin_trap(); }

static void *race(void *arg) {
    pthread_barrier_wait(&barrier);
    exit(10 + (int)(long)arg);
}

static void *wait_forever(void *arg) {
    pthread_mutex_lock(&mutex);
    for (;;) pthread_cond_wait(&cond, &mutex);
}

static void *read_stdin(void *arg) {
    char buf[16];
    read(0, buf, sizeof buf);
    return NULL;
}

static void *sleep_long(void *arg) {
    sleep(60);
    return NULL;
}

static void *nothing(void *arg) { return NULL; }

static void *spin(void *arg) {
    while (spinning) {}
    return NULL;
}

/** Start a thread running `f`. */
static pthread_t start(void *(*f)(void *), void *arg) {
    pthread_t t;
    if (pthread_create(&t, NULL, f, arg) != 0) exit(100);
    return t;
}

/** Give the threads started time to get where they wait. */
static void settle(void) {
    struct timespec ts = {0, 50 * 1000 * 1000};
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "";
    printf("%s\n", mode);
    fflush(stdout);
    if (!strcmp(mode, "thread-exit")) {
        pthread_join(start(exit_5, NULL), NULL);
    } else if (!strcmp(mode, "thread-trap")) {
        pthread_join(start(trap, NULL), NULL);
    } else if (!strcmp(mode, "negative")) {
        pthread_join(start(exit_minus_1, NULL), NULL);
    } else if (!strcmp(mode, "race")) {
        pthread_barrier_init(&barrier, NULL, 8);
        pthread_t ts[8];
        for (long i = 0; i < 8; i++) ts[i] = start(race, (void *)i);
        for (int i = 0; i < 8; i++) pthread_join(ts[i], NULL);
    } else if (!strcmp(mode, "futex")) {
        start(wait_forever, NULL);
        settle();
        exit(3);
    } else if (!strcmp(mode, "stdin")) {
        start(read_stdin, NULL);
        settle();
        exit(4);
    } else if (!strcmp(mode, "sleep")) {
        start(sleep_long, NULL);
        settle();
        exit(6);
    } else if (!strcmp(mode, "return")) {
        start(spin, NULL);
        settle();
        return 0;
    } else if (!strcmp(mode, "spare")) {
        pthread_join(start(nothing, NULL), NULL);
        exit(7);
    } else if (!strcmp(mode, "spin")) {
        start(spin, NULL);
        spin(NULL);
    }
    return 99; // not reached
}
