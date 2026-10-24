// Exercises the kernel's system calls: arguments, environment, files and directories, clocks,
// randomness, threads, and the exit code.
#include <dirent.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void *sum(void *arg) {
    long n = (long)arg, s = 0;
    for (long i = 1; i <= n; i++) s += i;
    return (void *)s;
}

static int by_name(const void *a, const void *b) {
    return strcmp(*(char *const *)a, *(char *const *)b);
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) printf("arg %d: %s\n", i, argv[i]);
    const char *greeting = getenv("GREETING");
    printf("env: %s\n", greeting ? greeting : "(unset)");

    // the file the runner loaded with --dir
    FILE *in = fopen("/data/input.txt", "r");
    char line[64] = {0};
    if (!in || !fgets(line, sizeof line, in)) { perror("input"); return 2; }
    fclose(in);
    printf("input: %s", line);

    // files and directories
    if (mkdir("/tmp", 0755) != 0 && errno != EEXIST) { perror("mkdir"); return 2; }
    if (mkdir("/tmp/out", 0755) != 0) { perror("mkdir"); return 2; }
    FILE *f = fopen("/tmp/out/b.txt", "w");
    fprintf(f, "%s", "written by the program\n");
    fclose(f);
    f = fopen("/tmp/out/a.txt", "w");
    fclose(f);
    f = fopen("/tmp/out/b.txt", "a");
    fprintf(f, "%s", "appended\n");
    fclose(f);
    struct stat st;
    stat("/tmp/out/b.txt", &st);
    printf("size: %lld, regular: %d\n", (long long)st.st_size, S_ISREG(st.st_mode));
    DIR *d = opendir("/tmp/out");
    char *names[8];
    int n = 0;
    for (struct dirent *e; (e = readdir(d));) {
        if (e->d_name[0] != '.') names[n++] = strdup(e->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof names[0], by_name);
    for (int i = 0; i < n; i++) printf("entry: %s\n", names[i]);
    rename("/tmp/out/a.txt", "/tmp/out/c.txt");
    printf("renamed: %d, gone: %d\n", access("/tmp/out/c.txt", F_OK) == 0, access("/tmp/out/a.txt", F_OK) != 0);
    unlink("/tmp/out/c.txt");
    printf("missing: %s\n", fopen("/nonexistent", "r") == NULL && errno == ENOENT ? "ENOENT" : "?");

    // clocks and randomness
    struct timespec a, b;
    clock_gettime(CLOCK_MONOTONIC, &a);
    usleep(20000);
    clock_gettime(CLOCK_MONOTONIC, &b);
    long ms = (b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000;
    printf("slept >= 20ms: %d\n", ms >= 20);
    unsigned char rnd[32];
    printf("random: %d\n", getentropy(rnd, sizeof rnd) == 0);

    // threads
    pthread_t t[4];
    for (long i = 0; i < 4; i++) pthread_create(&t[i], NULL, sum, (void *)(1000 * (i + 1)));
    for (int i = 0; i < 4; i++) {
        void *r;
        pthread_join(t[i], &r);
        printf("thread %d: %ld\n", i, (long)r);
    }
    return 7;
}
