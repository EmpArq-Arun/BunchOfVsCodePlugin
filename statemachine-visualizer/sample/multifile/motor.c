#include "motor.h"
#include "hal.h"
static int rpm = 0;
void Motor_Start(MotorDir dir) { HAL_SetDirection(dir); HAL_Enable(); rpm = 1000; }
void Motor_Stop(void)          { HAL_Disable(); rpm = 0; }
int  Motor_GetRPM(void)        { return rpm; }
