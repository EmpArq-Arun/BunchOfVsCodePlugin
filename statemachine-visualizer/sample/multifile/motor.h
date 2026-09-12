#ifndef MOTOR_H
#define MOTOR_H
typedef enum { MOTOR_FORWARD, MOTOR_REVERSE, MOTOR_STOP } MotorDir;
void Motor_Start(MotorDir dir);
void Motor_Stop(void);
int  Motor_GetRPM(void);
#endif
