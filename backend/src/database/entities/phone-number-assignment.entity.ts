import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum PhoneNumberType {
  BOT = 'BOT',
  DEDICATED = 'DEDICATED',
}

@Entity('phone_number_assignments')
@Index(['businessId', 'active'])
export class PhoneNumberAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Workspace (or tenant) this number belongs to */
  @Column({ name: 'business_id' })
  @Index()
  businessId: string;

  @Column({ name: 'number_e164', type: 'text' })
  @Index()
  numberE164: string;

  @Column({ type: 'enum', enum: PhoneNumberType })
  type: PhoneNumberType;

  /** Optional region code e.g. "US", "CA" */
  @Column({ type: 'text', nullable: true })
  region?: string;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
