#include "util.h"
#include <vector>

int total(std::vector<int>& v) {
    int s = 0;
    for (int x : v) s += square(x);
    return s;
}
