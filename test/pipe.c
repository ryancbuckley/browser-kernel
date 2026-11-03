// Echoes lines from stdin as they arrive and exits with the line count.
#include <stdio.h>

int main(void) {
    char line[64];
    int n = 0;
    while (fgets(line, sizeof line, stdin)) {
        printf("got: %s", line);
        fflush(stdout);
        n++;
    }
    return n;
}
