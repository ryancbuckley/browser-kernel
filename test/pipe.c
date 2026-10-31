// Echoes the lines of stdin, which the test writes a piece at a time, until its end; exits with
// the number of lines.
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
