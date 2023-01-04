import { DeepPartial, VendureEntity } from '@vendure/core';
import {
  SubscriptionBillingInterval,
  SubscriptionDurationInterval,
  SubscriptionStartMoment,
} from './generated/graphql';
import { Column, Entity } from 'typeorm';

@Entity()
export class Schedule extends VendureEntity {
  constructor(input?: DeepPartial<Schedule>) {
    super(input);
  }

  @Column({ nullable: false })
  name!: string;

  @Column({ type: 'integer', nullable: true })
  downpayment!: number;

  @Column({ nullable: false })
  durationInterval!: SubscriptionDurationInterval;

  @Column({ type: 'integer', nullable: false })
  durationCount!: number;

  @Column({ nullable: false })
  startMoment!: SubscriptionStartMoment;

  @Column({ nullable: false })
  billingInterval!: SubscriptionBillingInterval;

  @Column({ type: 'integer', nullable: false })
  billingCount!: number;

  /**
   * When billing and duration cycles are the same, this is a paid-up-front schedule
   * and the user pays the total amount of a subscription up front
   */
  get paidUpFront(): boolean {
    return (
      this.billingInterval.valueOf() == this.durationInterval.valueOf() &&
      this.billingCount.valueOf() == this.durationCount.valueOf()
    );
  }
}
