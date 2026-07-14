import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { CommunicationConversation } from './communication-conversation.entity';
import { ChannelType } from './sender.entity';
import { ContactIdentity } from './contact-identity.entity';

export enum MessageDirection {
  IN = 'in',
  OUT = 'out',
}

export enum MessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
}

@Entity('communication_messages')
export class CommunicationMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id' })
  @Index()
  conversationId: string;

  @Column({
    type: 'enum',
    enum: MessageDirection,
  })
  direction: MessageDirection;

  @Column({
    type: 'enum',
    enum: ChannelType,
    default: ChannelType.SMS,
  })
  channel: ChannelType;

  @Column({ type: 'text' })
  body: string;

  @Column({ name: 'from_number' })
  fromNumber: string;

  @Column({ name: 'to_number' })
  toNumber: string;

  @Column({ name: 'provider_message_id', nullable: true })
  @Index()
  providerMessageId: string;

  @Column({
    type: 'enum',
    enum: MessageStatus,
    default: MessageStatus.PENDING,
  })
  status: MessageStatus;

  @Column({ name: 'sent_by_user_id', nullable: true })
  @Index()
  sentByUserId: string;

  @Column({ name: 'from_identity_id', type: 'uuid', nullable: true })
  fromIdentityId?: string;

  @Column({ name: 'to_identity_id', type: 'uuid', nullable: true })
  toIdentityId?: string;

  @Column({ name: 'template_id', type: 'text', nullable: true })
  templateId?: string;

  @Column({ name: 'template_name', type: 'text', nullable: true })
  templateName?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * Owning provider integration for this message. Stamped at send/receive
   * time. Nullable for legacy rows; resolver falls back to
   * `metadata.integrationId` when NULL.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => CommunicationConversation, (conv) => conv.messages)
  @JoinColumn({ name: 'conversation_id' })
  conversation: CommunicationConversation;

  @ManyToOne(() => ContactIdentity, { nullable: true })
  @JoinColumn({ name: 'from_identity_id' })
  fromIdentity?: ContactIdentity;

  @ManyToOne(() => ContactIdentity, { nullable: true })
  @JoinColumn({ name: 'to_identity_id' })
  toIdentity?: ContactIdentity;
}
