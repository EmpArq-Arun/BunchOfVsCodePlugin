#include "door.h"
#include "motor.h"
#include "logger.h"
int main(void) {
    Log_Event("boot");
    Door_Tick(1);
    Door_Tick(2);
    int rpm = Motor_GetRPM();
    DoorState s = Door_GetState();
    return 0;
}
