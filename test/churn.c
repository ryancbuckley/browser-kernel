// Many short-lived threads, one after another (as Lean's task manager starts them): each must see
// fresh thread-local storage, whether or not the kernel runs it on an instance an earlier thread
// used. Prints the number of threads that saw it, and exits with 0 if all did.
#include <pthread.h>
#include <stdio.h>

static _Thread_local int local = 42;
static _Thread_local char buf[256] = "fresh";

static void *run(void *arg) {
    long ok = local == 42 && buf[0] == 'f';
    local = (int)(long)arg;
    buf[0] = 'x';
    return (void *)ok;
}

int main(void) {
    const int n = 200;
    int ok = 0;
    for (long i = 0; i < n; i++) {
        pthread_t t;
        void *r;
        if (pthread_create(&t, NULL, run, (void *)i) != 0) return 2;
        pthread_join(t, &r);
        ok += (long)r;
    }
    printf("%d of %d threads saw fresh thread-locals\n", ok, n);
    return ok == n ? 0 : 1;
}
