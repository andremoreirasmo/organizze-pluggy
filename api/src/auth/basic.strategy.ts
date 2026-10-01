import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { BasicStrategy as Strategy } from 'passport-http';

@Injectable()
export class BasicStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly config: ConfigService) {
    super();
  }

  validate(username: string, password: string): { username: string } | false {
    const expectedUser = this.config.getOrThrow<string>('APP_USER');
    const expectedPassword = this.config.getOrThrow<string>('APP_PASSWORD');

    if (username === expectedUser && password === expectedPassword) {
      return { username };
    }

    return false;
  }
}
