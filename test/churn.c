// Spawns 200 short-lived threads sequentially and verifies that each thread sees
// freshly initialized thread-local storage when the kernel reuses worker instances.
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
