import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { CommunicationMessage } from './communication-message.entity';
import { CommunicationCall } from './communication-call.entity';
import { ProviderType } from './communication-integration.entity';
import { ChannelType } from './sender.entity';
import { Sender } from './sender.entity';

@Entity('communication_conversations')
@Index(['workspaceId', 'externalId'], { unique: true })
@Index(['workspaceId', 'channel', 'provider'])
export class CommunicationConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  @Index()
  tenantId: string | null;

  // Cross-service reference to Callio's contact (plain UUID, no FK)
  @Column({ name: 'contact_id', type: 'uuid', nullable: true })
  @Index()
  contactId: string | null;

  @Column({ name: 'external_id' })
  externalId: string;

  @Column({
    type: 'enum',
    enum: ProviderType,
    default: ProviderType.OPENPHONE,
  })
  provider: ProviderType;

  @Column({
    type: 'enum',
    enum: ChannelType,
    default: ChannelType.SMS,
  })
  channel: ChannelType;

  @Column({ name: 'sender_id', type: 'uuid', nullable: true })
  senderId: string | null;

  @Column({ name: 'phone_number' })
  phoneNumber: string;

  @Column({ name: 'participant_phone_number', nullable: true })
  participantPhoneNumber: string;

  @Column({ name: 'participant_phone_numbers', type: 'jsonb', nullable: true })
  participantPhoneNumbers?: string[];

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => CommunicationMessage, (message) => message.conversation)
  messages: CommunicationMessage[];

  @OneToMany(() => CommunicationCall, (call) => call.conversation)
  calls: CommunicationCall[];

  @ManyToOne(() => Sender, { nullable: true })
  @JoinColumn({ name: 'sender_id' })
  sender?: Sender;
}
