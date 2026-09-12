#include "door.h"
#include "motor.h"
#include "logger.h"
static DoorState currentState = DOOR_CLOSED;
extern volatile int g_obstacleFlag;
void Door_Tick(int event) {
    switch (currentState) {
        case DOOR_CLOSED:
            if (event == 1) { Motor_Start(MOTOR_FORWARD); Log_Event("opening"); currentState = DOOR_OPENING; }
            break;
        case DOOR_OPENING:
            if (g_obstacleFlag)  { Motor_Stop(); currentState = DOOR_ERROR; }
            else if (event == 2) { Motor_Stop(); currentState = DOOR_OPEN; }
            break;
        case DOOR_OPEN:
            if (event == 3) { Motor_Start(MOTOR_REVERSE); currentState = DOOR_CLOSING; }
            break;
        case DOOR_CLOSING:
            if (g_obstacleFlag)  { Motor_Stop(); currentState = DOOR_OPENING; }
            else if (event == 2) { Motor_Stop(); currentState = DOOR_CLOSED; }
            break;
        case DOOR_ERROR:
            if (event == 0) { currentState = DOOR_CLOSED; }
            break;
        default: break;
    }
}
DoorState Door_GetState(void) { return currentState; }
